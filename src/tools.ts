import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import { MAX_SUBAGENT_DEPTH, MAX_PARALLEL_AGENTS } from "./constants.js";
import {
  BASH_TIMEOUT_MS,
  DEFAULT_READ_FILE_LIMIT,
  MAX_LIST_FILES_RESULTS,
  MAX_GREP_RESULTS,
  MAX_FILE_READ_SIZE,
  PREVIEW,
  SKIP_DIRS,
  MODE_PLAN,
  MODE_BUILD,
  WEB_FETCH_MAX_CHARS,
  WEB_FETCH_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  HTTP_MAX_RESPONSE_CHARS,
  DEFAULT_TREE_DEPTH,
  MAX_TREE_FILES,
} from "./constants.js";
import { SubagentPool, type PoolTask } from "./subagent-pool.js";
import { GitWorktreeManager } from "./git-worktree.js";
import type { McpManager, McpToolInfo } from "./mcp.js";
import { CustomToolLoader } from "./custom-tools.js";
import { getCustomToolsEnabled } from "./config.js";
import { PipelineEngine } from "./pipeline.js";
import { RefactoringEngine } from "./refactoring-engine.js";
import { MultiAgentOrchestrator } from "./multi-agent.js";
import { TimeMachine } from "./time-machine.js";
import { PredictiveBugDetector } from "./predictive-bugs.js";

/** Structured log event for tool usage display. */
export type ToolLogEvent =
  | { type: "tool_call"; tool: string; args: string }
  | { type: "tool_result"; tool: string; result: string };

/** LogFn can accept either a plain string or a structured ToolLogEvent. */
export type LogFn = (msg: string | ToolLogEvent) => void;

/** Minimal task type used by the todo_list tool. Defined here to avoid circular imports. */
export interface TaskItem {
  id: number;
  text: string;
  status: "pending" | "in_progress" | "done";
  created: string;
}

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  /** Schema for array items (when type === "array"). */
  items?: ToolParameterProperty;
  /** Nested properties (when type === "object"). */
  properties?: Record<string, ToolParameterProperty>;
  /** Required fields for nested objects. */
  required?: string[];
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameters;
  };
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameters;
  schema(): ToolSchema;
  call(kwargs: Record<string, unknown>): string | Promise<string>;
}

type Handler = (...args: unknown[]) => string | Promise<string>;

export function createTool<P extends unknown[]>(
  name: string,
  description: string,
  parameters: ToolParameters,
  handler: (...args: P) => string | Promise<string>
): Tool {
  return {
    name,
    description,
    parameters,
    schema() {
      return {
        type: "function",
        function: { name, description, parameters },
      };
    },
    call(kwargs: Record<string, unknown>): string | Promise<string> {
      const paramNames = Object.keys(parameters.properties);
      const args = paramNames.map((p) => kwargs[p]);
      return handler(...(args as P));
    },
  };
}

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s/,
  /\bmv\s/,
  /\bcp\s/,
  />>(?![&])/,
  /\bsed\s+-i\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bdd\b/,
  /\btruncate\b/,
  /\bpip\s+install\b/,
  /\bnpm\s+install\b/,
  /\bgit\s+(commit|push|reset|checkout|merge|rebase)\b/,
];

function looksDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}

function runBash(command: string): string {
  try {
    const result = execSync(command, {
      timeout: BASH_TIMEOUT_MS,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result;
  } catch (e: unknown) {
    const err = e as {
      status?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const stdout = err.stdout || "";
    const stderr = err.stderr || "";
    if (err.message?.includes("timed out")) {
      return `Error: command timed out after ${BASH_TIMEOUT_MS / 1000}s`;
    }
    const parts: string[] = [];
    if (stdout) parts.push(stdout);
    if (stderr) parts.push(`STDERR:\n${stderr}`);
    return `Exit code: ${err.status ?? 1}\n${parts.join("\n")}`;
  }
}

export function makeBashTool(readOnly: boolean): Tool {
  function handler(command: string): string {
    if (readOnly && looksDestructive(command)) {
      return (
        "Blocked: this command looks like it writes to disk or changes state, " +
        "which isn't allowed in Plan mode (this is a regex heuristic, not a sandbox — " +
        "don't rely on it for untrusted input). Describe the change in your plan instead, " +
        "or switch to Build mode / delegate the change to a Build-mode subagent."
      );
    }
    return runBash(command);
  }

  let desc = "Execute a shell command and return stdout/stderr.";
  if (readOnly) {
    desc +=
      " PLAN MODE: commands that look like writes (rm, mv, sed -i, pip install, git commit, ...) are blocked.";
  }

  return createTool(
    "bash",
    desc,
    {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute.",
        },
      },
      required: ["command"],
    },
    handler
  );
}

export function makeReadFileTool(): Tool {
  function handler(
    filePath: string,
    offset?: number,
    limit?: number
  ): string {
    const start = Math.max(0, offset ?? 0);
    const maxLines = limit ?? DEFAULT_READ_FILE_LIMIT;
    try {
      const stat = fs.statSync(filePath);
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      if (stat.size > MAX_FILE_READ_SIZE) {
        return `File too large (${sizeMB} MB). Max: 10 MB. Use offset/limit for large files.`;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const total = lines.length;
      const end = Math.min(total, start + maxLines);
      const numbered = lines
        .slice(start, end)
        .map((line, i) => `${i + start + 1}: ${line}`);
      let result = numbered.join("\n");
      if (end < total) {
        result += `\n... (${total - end} more lines)`;
      }
      return result;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return `Error: file not found: ${filePath}`;
      }
      return `Error reading ${filePath}: ${e}`;
    }
  }

  return createTool(
    "read_file",
    "Read the contents of a file. Returns numbered lines. Use offset/limit for large files.",
    {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path (absolute or relative).",
        },
        offset: {
          type: "integer",
          description: "Line number to start from (0-based). Default 0.",
        },
        limit: {
          type: "integer",
          description: `Max lines to return. Default ${DEFAULT_READ_FILE_LIMIT}.`,
        },
      },
      required: ["path"],
    },
    handler
  );
}

export function makeWriteFileTool(): Tool {
  function handler(filePath: string, content: string): string {
    try {
      const dirName = path.dirname(filePath);
      if (dirName) {
        fs.mkdirSync(dirName, { recursive: true });
      }
      fs.writeFileSync(filePath, content, "utf-8");
      return `OK: wrote ${content.length} chars to ${filePath}`;
    } catch (e) {
      return `Error writing ${filePath}: ${e}`;
    }
  }

  return createTool(
    "write_file",
    "Write content to a file, creating parent directories if needed. Overwrites existing files.",
    {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path to write to.",
        },
        content: {
          type: "string",
          description: "The full content to write.",
        },
      },
      required: ["path", "content"],
    },
    handler
  );
}

export function makeEditFileTool(): Tool {
  function handler(filePath: string, old: string, newStr: string): string {
    let content: string;
    try {
      const stat = fs.statSync(filePath);
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      if (stat.size > MAX_FILE_READ_SIZE) {
        return `File too large (${sizeMB} MB). Max: 10 MB. Use offset/limit for large files.`;
      }
      content = fs.readFileSync(filePath, "utf-8");
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return `Error: file not found: ${filePath}`;
      }
      return `Error reading ${filePath}: ${e}`;
    }

    const count = content.split(old).length - 1;
    if (count === 0) {
      return `Error: old text not found in ${filePath}`;
    }
    if (count > 1) {
      return `Error: old text found ${count} times in ${filePath}. Provide more context to make it unique.`;
    }

    const updated = content.replace(old, newStr);
    const newSize = Buffer.byteLength(updated, "utf-8");
    if (newSize > MAX_FILE_READ_SIZE) {
      const sizeMB = (newSize / (1024 * 1024)).toFixed(1);
      return `Edit would produce file too large (${sizeMB} MB). Max: 10 MB.`;
    }
    try {
      fs.writeFileSync(filePath, updated, "utf-8");
      return `OK: replaced 1 occurrence in ${filePath}`;
    } catch (e) {
      return `Error writing ${filePath}: ${e}`;
    }
  }

  return createTool(
    "edit_file",
    "Replace an exact text snippet in a file. The old text must appear exactly once.",
    {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path.",
        },
        old: {
          type: "string",
          description: "Exact text to find and replace.",
        },
        new: {
          type: "string",
          description: "Replacement text.",
        },
      },
      required: ["path", "old", "new"],
    },
    handler
  );
}

export function makeListFilesTool(): Tool {
  function handler(dirPath?: string, pattern?: string): string {
    const base = dirPath || ".";
    const pat = pattern || "*";
    try {
      const results: string[] = [];
      const visited = new Set<string>();

      function walk(dir: string, rel: string): void {
        let realDir: string;
        try {
          realDir = fs.realpathSync(dir);
        } catch {
          return;
        }
        if (visited.has(realDir)) return;
        visited.add(realDir);

        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walk(path.join(dir, entry.name), entryRel);
          } else {
            if (pat === "*" || pat === "**/*") {
              results.push(entryRel);
            } else if (pat.startsWith("**/*.")) {
              const ext = pat.slice(4);
              if (entry.name.endsWith(ext)) results.push(entryRel);
            } else if (pat.startsWith("*.")) {
              const ext = pat.slice(1);
              if (entry.name.endsWith(ext)) results.push(entryRel);
            } else {
              if (entry.name.endsWith(pat) || entry.name === pat) {
                results.push(entryRel);
              }
            }
          }
        }
      }

      walk(base, "");
      results.sort();

      if (results.length === 0) {
        return `No files matching '${pat}' in ${base}`;
      }
      const limited = results.slice(0, MAX_LIST_FILES_RESULTS);
      let output = limited.join("\n");
      if (results.length > MAX_LIST_FILES_RESULTS) {
        output += `\n... (${results.length - MAX_LIST_FILES_RESULTS} more)`;
      }
      return output;
    } catch (e) {
      return `Error listing files: ${e}`;
    }
  }

  return createTool(
    "list_files",
    "List files in a directory, optionally with a glob pattern.",
    {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path. Default '.'.",
        },
        pattern: {
          type: "string",
          description: "Glob pattern (e.g. '*.py', '**/*.js'). Default '*'.",
        },
      },
    },
    handler
  );
}

/**
 * Check if a regex pattern contains nested quantifiers (e.g., (a+)+, (a|b)*).
 * These patterns can cause catastrophic backtracking (ReDoS).
 */
function hasNestedQuantifiers(pattern: string): boolean {
  // Matches: group containing a quantifier (*+?), followed by a quantifier
  // e.g., (a+)+, (a*)+, (a+)*, (a|b)+, (...){2,}
  return /(\([^)]*[+*][^)]*\))[+*{]/.test(pattern);
}

/**
 * Validate a regex by compiling it and testing on a small sample.
 * Returns the compiled regex or an error message.
 */
function safeCompileRegex(pattern: string): RegExp | string {
  if (hasNestedQuantifiers(pattern)) {
    return "Regex rejected: pattern contains nested quantifiers (potential ReDoS). Simplify the pattern.";
  }
  try {
    const regex = new RegExp(pattern);
    // Quick smoke test on a small string to check for catastrophic backtracking
    const testStart = Date.now();
    regex.test("abcdefghijklmnopqrstuvwxyz0123456789");
    if (Date.now() - testStart > 500) {
      return "Regex rejected: pattern is too slow (exceeded 500ms on test input). Simplify the pattern.";
    }
    return regex;
  } catch (e) {
    return `Invalid regex: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Check if a hostname resolves to a private/internal IP.
 * Blocks common SSRF targets: loopback, private ranges, link-local, cloud metadata.
 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  // Block common patterns before DNS resolution
  if (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h === "[::1]" ||
    h === "127.0.0.1" ||
    h === "169.254.169.254" || // AWS/GCP/Azure metadata
    h === "metadata.google.internal"
  ) {
    return true;
  }
  // Match private IPv4 ranges: 10.x, 172.16-31.x, 192.168.x
  if (/^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}|192\.168\.\d{1,3})\.\d{1,3}$/.test(h)) {
    return true;
  }
  // Match loopback 127.x
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return true;
  }
  // Match IPv6 private range fc00::/7 and link-local fe80::
  if (/^f[cd]/i.test(h) || /^fe80:/i.test(h)) {
    return true;
  }
  return false;
}

export function makeGrepTool(): Tool {
  function handler(
    pattern: string,
    searchPath?: string,
    include?: string
  ): string {
    const base = searchPath || ".";
    const results: string[] = [];
    const compiled = safeCompileRegex(pattern);
    if (typeof compiled === "string") {
      return compiled;
    }
    const regex = compiled;
    const skipDirs = SKIP_DIRS;
    const visited = new Set<string>();

    function walk(dir: string): void {
      let realDir: string;
      try {
        realDir = fs.realpathSync(dir);
      } catch {
        return;
      }
      if (visited.has(realDir)) return;
      visited.add(realDir);

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name)) continue;
          walk(path.join(dir, entry.name));
        } else {
          if (include && !entry.name.endsWith(include)) continue;
          const fpath = path.join(dir, entry.name);
          try {
            const content = fs.readFileSync(fpath, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                results.push(`${fpath}:${i + 1}: ${lines[i].trimEnd()}`);
                if (results.length >= MAX_GREP_RESULTS) {
                  return;
                }
              }
            }
          } catch {
            // skip unreadable files
          }
        }
      }
    }

    try {
      walk(base);
    } catch (e) {
      return `Error searching: ${e}`;
    }

    if (results.length === 0) {
      return `No matches for '${pattern}' in ${base}`;
    }

    let output = results.join("\n");
    if (results.length >= MAX_GREP_RESULTS) {
      output += `\n... (truncated at ${MAX_GREP_RESULTS} matches)`;
    }
    return output;
  }

  return createTool(
    "grep",
    "Search file contents using regex pattern. Skips .git, __pycache__, node_modules.",
    {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to search for.",
        },
        path: {
          type: "string",
          description: "Directory to search in. Default '.'.",
        },
        include: {
          type: "string",
          description: "Only search files ending with this (e.g. '.py').",
        },
      },
      required: ["pattern"],
    },
    handler
  );
}

export function makeGitStatusTool(): Tool {
  function handler(): string {
    return runBash("git status --short --branch");
  }
  return createTool(
    "git_status",
    "Show the current git status (branch + changed/untracked files, short format).",
    { type: "object", properties: {} },
    handler
  );
}

export function makeGitDiffTool(): Tool {
  function handler(pathArg?: string, staged?: boolean): string {
    const parts = ["git", "diff", "--no-color"];
    if (staged) parts.push("--staged");
    if (pathArg && pathArg.trim()) parts.push("--", pathArg.trim());
    const out = runBash(parts.join(" "));
    return out.trim() === "" ? "(no changes)" : out;
  }
  return createTool(
    "git_diff",
    "Show the git diff of working-tree changes. Set staged=true for staged changes; " +
      "optionally limit to a single path.",
    {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional file/directory path to limit the diff.",
        },
        staged: {
          type: "boolean",
          description: "If true, show staged (index) changes instead of working tree.",
        },
      },
    },
    handler
  );
}

export function makeWebFetchTool(): Tool {
  async function handler(url?: string): Promise<string> {
    if (!url || !/^https?:\/\//i.test(url)) {
      return "Error: 'url' must be an http(s) URL.";
    }
    try {
      const resp = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "klyxor-web-fetch/1.0" },
        signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        return `Error: HTTP ${resp.status} ${resp.statusText} for ${url}`;
      }
      const contentType = resp.headers.get("content-type") || "";
      const raw = await resp.text();

      let text = raw;
      if (contentType.includes("html") || /<html[\s>]/i.test(raw)) {
        text = raw
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/&lt;/gi, "<")
          .replace(/&gt;/gi, ">")
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
          .replace(/[ \t]+/g, " ")
          .replace(/\n\s*\n\s*\n+/g, "\n\n")
          .trim();
      }

      if (text.length > WEB_FETCH_MAX_CHARS) {
        text =
          text.slice(0, WEB_FETCH_MAX_CHARS) +
          `\n…[truncated at ${WEB_FETCH_MAX_CHARS} chars]`;
      }
      return text || "(empty response)";
    } catch (e) {
      return `Error fetching ${url}: ${e}`;
    }
  }
  return createTool(
    "web_fetch",
    "Fetch a URL over HTTP(S) and return its text content (HTML is stripped to readable text).",
    {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The http(s) URL to fetch.",
        },
      },
      required: ["url"],
    },
    handler
  );
}

function makeDelegateTool(
  depth: number,
  log: LogFn,
  runAgentFn: (
    task: string,
    mode: string,
    depth: number,
    log: LogFn
  ) => Promise<string>
): Tool {
  async function handler(task: string, mode?: string): Promise<string> {
    if (depth >= MAX_SUBAGENT_DEPTH) {
      return `Error: max delegation depth (${MAX_SUBAGENT_DEPTH}) reached, cannot delegate further.`;
    }
    const actualMode = mode === MODE_PLAN || mode === MODE_BUILD ? mode : MODE_BUILD;
    log(
      `↳ delegating (mode=${actualMode}, depth=${depth + 1}): ${task.slice(0, PREVIEW.task)}`
    );
    return runAgentFn(task, actualMode, depth + 1, log);
  }

  return createTool(
    "delegate",
    "Delegate a self-contained subtask to a fresh subagent with its own context window. " +
      "Use this to keep your own context focused (e.g. 'investigate why test X fails' as a " +
      "subtask instead of doing it inline). The subagent has NO access to your conversation — " +
      "include everything it needs to know in `task`. You get back only its final answer, " +
      "not its internal steps.",
    {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Full, self-contained description of the subtask.",
        },
        mode: {
          type: "string",
          enum: [MODE_PLAN, MODE_BUILD],
          description:
            "plan = read-only investigation/planning only; build = full execution. Default build.",
        },
      },
      required: ["task"],
    },
    handler
  );
}

/**
 * Create a tool that spawns multiple subagents in parallel.
 *
 * @param depth - Current delegation depth.
 * @param log - Logging function.
 * @param runAgentFn - The runAgent implementation to delegate to.
 * @returns A Tool that accepts an array of tasks and runs them concurrently.
 */
function makeSpawnParallelTool(
  depth: number,
  log: LogFn,
  runAgentFn: (
    task: string,
    mode: string,
    depth: number,
    log: LogFn
  ) => Promise<string>
): Tool {
  async function handler(
    tasks: Array<{ task: string; mode?: string }>
  ): Promise<string> {
    if (depth >= MAX_SUBAGENT_DEPTH) {
      return `Error: max delegation depth (${MAX_SUBAGENT_DEPTH}) reached, cannot spawn parallel agents.`;
    }

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return "Error: 'tasks' must be a non-empty array of task objects.";
    }

    if (tasks.length > MAX_PARALLEL_AGENTS) {
      return `Error: too many parallel tasks: ${tasks.length} (max ${MAX_PARALLEL_AGENTS}).`;
    }

    // Validate each task has a string task field
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (!t || typeof t.task !== "string" || !t.task.trim()) {
        return `Error: task at index ${i} is missing a valid 'task' string.`;
      }
    }

    const pool = new SubagentPool(depth, log, runAgentFn);
    const poolTasks: PoolTask[] = tasks.map((t) => ({
      task: t.task,
      mode: t.mode,
    }));

    const result = await pool.run(poolTasks);
    return SubagentPool.formatResult(result);
  }

  return createTool(
    "spawn_parallel",
    `Spawn up to ${MAX_PARALLEL_AGENTS} subagents that run concurrently. ` +
      "Each subagent gets its own context window. Use this when you have multiple independent " +
      "subtasks that can proceed in parallel (e.g. 'investigate module A' and 'write tests for module B'). " +
      "All subagents must finish before you get results. You get back a summary of each subagent's result.",
    {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: `Array of tasks to run in parallel (max ${MAX_PARALLEL_AGENTS}).`,
          items: {
            type: "object",
            properties: {
              task: {
                type: "string",
                description: "Full, self-contained description of the subtask.",
              },
              mode: {
                type: "string",
                enum: [MODE_PLAN, MODE_BUILD],
                description:
                  "plan = read-only investigation; build = full execution. Default build.",
              },
            },
            required: ["task"],
          },
        },
      },
      required: ["tasks"],
    },
    handler
  );
}

/**
 * Provider that supplies tasks and the ability to generate new IDs.
 * Implemented by ChatSession; passed by reference to avoid circular imports.
 */
export interface TaskProvider {
  tasks: TaskItem[];
  nextTaskId(): number;
}

function makeTodoListTool(provider: TaskProvider): Tool {
  function renderList(): string {
    const { tasks } = provider;
    if (tasks.length === 0) return "(empty)";
    return tasks.map((t) => {
      const mark = t.status === "done" ? "✓" : t.status === "in_progress" ? "►" : "○";
      return `${mark} [${t.id}] ${t.text}`;
    }).join("\n");
  }

  function handler(
    action?: string,
    id?: number,
    text?: string,
    status?: string
  ): string {
    const act = (action || "list").toLowerCase();
    const { tasks } = provider;

    if (act === "list") {
      return `📋 Todo list:\n${renderList()}`;
    }

    if (act === "add") {
      if (!text || !text.trim()) return "Error: 'text' is required for add.";
      const task: TaskItem = {
        id: provider.nextTaskId(),
        text: text.trim(),
        status: "pending",
        created: new Date().toISOString(),
      };
      tasks.push(task);
      return `Added task [${task.id}]: ${task.text}\n\n📋 Current todo list:\n${renderList()}`;
    }

    if (act === "update") {
      if (id == null) return "Error: 'id' is required for update.";
      const task = tasks.find((t) => t.id === id);
      if (!task) return `Error: task [${id}] not found.`;
      if (text && text.trim()) task.text = text.trim();
      if (status) {
        const normalized = status.toLowerCase();
        if (normalized === "pending" || normalized === "in_progress" || normalized === "done") {
          task.status = normalized;
        } else {
          return `Error: status must be 'pending', 'in_progress', or 'done'. Got '${status}'.`;
        }
      }
      return `Updated task [${task.id}]: ${task.text} (${task.status})\n\n📋 Current todo list:\n${renderList()}`;
    }

    if (act === "delete" || act === "remove") {
      if (id == null) return "Error: 'id' is required for delete.";
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx === -1) return `Error: task [${id}] not found.`;
      const removed = tasks.splice(idx, 1)[0]!;
      return `Deleted task [${removed.id}]: ${removed.text}\n\n📋 Current todo list:\n${renderList()}`;
    }

    return `Error: unknown action '${act}'. Valid: list, add, update, delete.`;
  }

  return createTool(
    "todo_list",
    "Manage a task list for tracking progress through multi-step work. " +
      "Use 'add' to create tasks, 'update' to change status/text, 'delete' to remove, 'list' to view all. " +
      "Set status to 'in_progress' when starting a task and 'done' when finished.",
    {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "update", "delete", "list"],
          description: "Action: add, update, delete, or list. Default 'list'.",
        },
        id: {
          type: "number",
          description: "Task ID (required for update/delete).",
        },
        text: {
          type: "string",
          description: "Task description (required for add; optional for update to change text).",
        },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "done"],
          description: "New status (for update only).",
        },
      },
    },
    handler
  );
}

// ── New tools ──────────────────────────────────────────────────

export function makeHttpRequestTool(): Tool {
  async function handler(
    url: string,
    method?: string,
    headers?: string,
    body?: string
  ): Promise<string> {
    if (!url || !/^https?:\/\//i.test(url)) {
      return "Error: 'url' must be an http(s) URL.";
    }

    // SSRF protection: block requests to private/internal networks
    try {
      const parsed = new URL(url);
      if (isPrivateHost(parsed.hostname)) {
        return "SSRF blocked: requests to internal/private networks are not allowed";
      }
    } catch {
      return "Error: invalid URL format.";
    }

    const httpMethod = (method || "GET").toUpperCase();
    const validMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"];
    if (!validMethods.includes(httpMethod)) {
      return `Error: invalid method '${httpMethod}'. Valid: ${validMethods.join(", ")}`;
    }

    let parsedHeaders: Record<string, string> = {};
    if (headers && headers.trim()) {
      try {
        parsedHeaders = JSON.parse(headers) as Record<string, string>;
      } catch {
        return "Error: 'headers' must be valid JSON.";
      }
    }

    const fetchOptions: RequestInit = {
      method: httpMethod,
      headers: parsedHeaders,
      signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
    };

    if (body && httpMethod !== "GET" && httpMethod !== "HEAD") {
      fetchOptions.body = body;
    }

    try {
      const resp = await fetch(url, fetchOptions);
      const responseHeaders: Record<string, string> = {};
      resp.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const text = await resp.text();
      const truncated =
        text.length > HTTP_MAX_RESPONSE_CHARS
          ? text.slice(0, HTTP_MAX_RESPONSE_CHARS) +
            `\n…[truncated at ${HTTP_MAX_RESPONSE_CHARS} chars]`
          : text;

      const headerStr = JSON.stringify(responseHeaders, null, 2);
      return `Status: ${resp.status} ${resp.statusText}\nHeaders:\n${headerStr}\nBody:\n${truncated || "(empty)"}`;
    } catch (e) {
      return `Error: ${e}`;
    }
  }

  return createTool(
    "http_request",
    "Make an HTTP request to a URL. Returns status, headers, and body.",
    {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to request (http or https).",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"],
          description: "HTTP method. Default GET.",
        },
        headers: {
          type: "string",
          description: "Request headers as a JSON object string.",
        },
        body: {
          type: "string",
          description: "Request body (for POST/PUT/PATCH).",
        },
      },
      required: ["url"],
    },
    handler
  );
}

export function makeJsonQueryTool(): Tool {
  function handler(filePath: string, query?: string): string {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return `Error: file not found: ${filePath}`;
      }
      return `Error reading ${filePath}: ${e}`;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return `Error: ${filePath} is not valid JSON.`;
    }

    if (!query || !query.trim()) {
      return JSON.stringify(parsed, null, 2);
    }

    const keys = query.split(".");
    let current: unknown = parsed;
    for (const key of keys) {
      if (current == null || typeof current !== "object") {
        return `Error: cannot navigate to '${key}' — current value is not an object.`;
      }
      const obj = current as Record<string, unknown>;
      if (!(key in obj)) {
        return `Error: key '${key}' not found in ${filePath}.`;
      }
      current = obj[key];
    }

    return typeof current === "string" ? current : JSON.stringify(current, null, 2);
  }

  return createTool(
    "json_query",
    "Read a JSON file and optionally query it with dot-notation path (e.g. 'users.0.name').",
    {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the JSON file.",
        },
        query: {
          type: "string",
          description: "Dot-notation path to navigate into the JSON. Omit to return the whole file.",
        },
      },
      required: ["path"],
    },
    handler
  );
}

export function makeEnvReadTool(): Tool {
  function handler(name?: string): string {
    if (name && name.trim()) {
      const val = process.env[name];
      if (val === undefined) {
        return `Environment variable '${name}' is not set.`;
      }
      return val;
    }

    const commonVars = [
      "HOME", "USER", "SHELL", "PATH", "LANG", "LC_ALL",
      "NODE_ENV", "NODE_VERSION", "npm_config_cache",
      "TEMP", "TMP", "TMPDIR",
      "EDITOR", "VISUAL", "PAGER",
      "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
      "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
      "AWS_REGION", "AWS_ACCESS_KEY_ID",
      "DATABASE_URL", "REDIS_URL",
      "PORT", "HOST",
      "DEBUG", "VERBOSE",
      "CI", "GITHUB_ACTIONS",
    ];

    const found: string[] = [];
    for (const key of commonVars) {
      if (process.env[key] !== undefined) {
        found.push(`${key}=${process.env[key]}`);
      }
    }

    if (found.length === 0) {
      return "No common environment variables are set.";
    }
    return `Common environment variables (${found.length}):\n${found.join("\n")}`;
  }

  return createTool(
    "env_read",
    "Read environment variables. Pass a specific name to get its value, or omit to list common vars.",
    {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Specific environment variable name. Omit to list common vars.",
        },
      },
    },
    handler
  );
}

export function makeFileInfoTool(): Tool {
  function handler(filePath: string): string {
    try {
      const stats = fs.statSync(filePath);
      const lines = [
        `Path: ${filePath}`,
        `Size: ${stats.size} bytes`,
        `Created: ${stats.birthtime.toISOString()}`,
        `Modified: ${stats.mtime.toISOString()}`,
        `Permissions: ${(stats.mode & 0o777).toString(8)}`,
        `Is file: ${stats.isFile()}`,
        `Is directory: ${stats.isDirectory()}`,
        `Is symlink: ${stats.isSymbolicLink()}`,
      ];
      return lines.join("\n");
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return `Error: file not found: ${filePath}`;
      }
      return `Error getting info for ${filePath}: ${e}`;
    }
  }

  return createTool(
    "file_info",
    "Get file metadata: size, timestamps, permissions, and type.",
    {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file or directory.",
        },
      },
      required: ["path"],
    },
    handler
  );
}

export function makeCopyFileTool(): Tool {
  function handler(source: string, destination: string): string {
    try {
      fs.copyFileSync(source, destination);
      return `OK: copied ${source} to ${destination}`;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return `Error: source file not found: ${source}`;
      }
      return `Error copying ${source} to ${destination}: ${e}`;
    }
  }

  return createTool(
    "copy_file",
    "Copy a file from source to destination. BLOCKED in Plan mode.",
    {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Source file path.",
        },
        destination: {
          type: "string",
          description: "Destination file path.",
        },
      },
      required: ["source", "destination"],
    },
    handler
  );
}

export function makeMoveFileTool(): Tool {
  function handler(source: string, destination: string): string {
    try {
      fs.renameSync(source, destination);
      return `OK: moved ${source} to ${destination}`;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return `Error: source file not found: ${source}`;
      }
      return `Error moving ${source} to ${destination}: ${e}`;
    }
  }

  return createTool(
    "move_file",
    "Move or rename a file. BLOCKED in Plan mode.",
    {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Source file path.",
        },
        destination: {
          type: "string",
          description: "Destination file path.",
        },
      },
      required: ["source", "destination"],
    },
    handler
  );
}

export function makeDiffApplyTool(): Tool {
  function handler(filePath: string, diffContent: string): string {
    let original: string;
    try {
      original = fs.readFileSync(filePath, "utf-8");
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return `Error: file not found: ${filePath}`;
      }
      return `Error reading ${filePath}: ${e}`;
    }

    const lines = original.split("\n");
    const diffLines = diffContent.split("\n");

    let removed = 0;
    let added = 0;
    let i = 0;

    while (i < diffLines.length) {
      const line = diffLines[i]!;

      if (line.startsWith("-") && !line.startsWith("---")) {
        const content = line.slice(1);
        const idx = lines.indexOf(content);
        if (idx === -1) {
          return `Error: line not found for removal: "${content.slice(0, 80)}"`;
        }
        lines.splice(idx, 1);
        removed++;
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        const content = line.slice(1);
        // Find the previous removed line's position, or append at end
        let insertIdx = lines.length;
        for (let j = i - 1; j >= 0; j--) {
          const prev = diffLines[j]!;
          if (prev.startsWith("-") && !prev.startsWith("---")) {
            const prevContent = prev.slice(1);
            const idx = lines.indexOf(prevContent);
            if (idx !== -1) {
              insertIdx = idx + 1;
            }
            break;
          }
        }
        lines.splice(insertIdx, 0, content);
        added++;
      }
      i++;
    }

    try {
      fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
      return `OK: applied diff to ${filePath} (${removed} lines removed, ${added} lines added)`;
    } catch (e) {
      return `Error writing ${filePath}: ${e}`;
    }
  }

  return createTool(
    "diff_apply",
    "Apply a unified diff patch to a file. Lines starting with '-' are removed, '+' are added. BLOCKED in Plan mode.",
    {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file to patch.",
        },
        diff_content: {
          type: "string",
          description: "The diff content: lines starting with '-' are removed, '+' are added.",
        },
      },
      required: ["file_path", "diff_content"],
    },
    handler
  );
}

export function makeTreeTool(): Tool {
  function handler(dirPath?: string, maxDepth?: number): string {
    const base = dirPath || ".";
    const depth = maxDepth ?? DEFAULT_TREE_DEPTH;
    const files: string[] = [];

    function walk(dir: string, prefix: string, currentDepth: number): void {
      if (currentDepth > depth || files.length >= MAX_TREE_FILES) return;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      const sorted = entries
        .filter((e) => !SKIP_DIRS.has(e.name))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

      for (let i = 0; i < sorted.length && files.length < MAX_TREE_FILES; i++) {
        const entry = sorted[i]!;
        const isLast = i === sorted.length - 1;
        const connector = isLast ? "└── " : "├── ";
        const childPrefix = isLast ? "    " : "│   ";

        files.push(`${prefix}${connector}${entry.name}`);

        if (entry.isDirectory()) {
          walk(
            path.join(dir, entry.name),
            prefix + childPrefix,
            currentDepth + 1
          );
        }
      }
    }

    files.push(base);
    walk(base, "", 1);

    if (files.length >= MAX_TREE_FILES) {
      files.push(`… (truncated at ${MAX_TREE_FILES} entries)`);
    }

    return files.join("\n");
  }

  return createTool(
    "tree",
    "Display a directory tree with indentation. Skips .git, __pycache__, node_modules.",
    {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path. Default '.'.",
        },
        max_depth: {
          type: "integer",
          description: `Max directory depth. Default ${DEFAULT_TREE_DEPTH}.`,
        },
      },
    },
    handler
  );
}

export function makeHashTool(): Tool {
  function handler(filePath?: string, content?: string, algorithm?: string): string {
    const algo = algorithm || "sha256";
    const validAlgos = ["md5", "sha1", "sha256"];
    if (!validAlgos.includes(algo)) {
      return `Error: invalid algorithm '${algo}'. Valid: ${validAlgos.join(", ")}`;
    }

    let data: string;
    if (filePath) {
      try {
        const stat = fs.statSync(filePath);
        const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
        if (stat.size > MAX_FILE_READ_SIZE) {
          return `File too large (${sizeMB} MB). Max: 10 MB.`;
        }
        data = fs.readFileSync(filePath, "utf-8");
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return `Error: file not found: ${filePath}`;
        }
        return `Error reading ${filePath}: ${e}`;
      }
    } else if (content) {
      data = content;
    } else {
      return "Error: provide either 'path' or 'content'.";
    }

    const hash = crypto.createHash(algo).update(data).digest("hex");
    const label = filePath ? `file: ${filePath}` : "provided content";
    return `${algo.toUpperCase()}(${label}) = ${hash}`;
  }

  return createTool(
    "hash",
    "Compute MD5, SHA1, or SHA256 hash of a file or string content.",
    {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to file to hash.",
        },
        content: {
          type: "string",
          description: "String content to hash (alternative to path).",
        },
        algorithm: {
          type: "string",
          enum: ["md5", "sha1", "sha256"],
          description: "Hash algorithm. Default sha256.",
        },
      },
    },
    handler
  );
}

export function makeBase64Tool(): Tool {
  function handler(action?: string, text?: string): string {
    const act = (action || "encode").toLowerCase();
    if (!text) {
      return "Error: 'text' is required.";
    }

    if (act === "encode") {
      return Buffer.from(text, "utf-8").toString("base64");
    }
    if (act === "decode") {
      try {
        return Buffer.from(text, "base64").toString("utf-8");
      } catch {
        return "Error: invalid base64 string.";
      }
    }
    return `Error: unknown action '${act}'. Valid: encode, decode.`;
  }

  return createTool(
    "base64",
    "Encode text to base64 or decode base64 to text.",
    {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["encode", "decode"],
          description: "Action: encode or decode. Default encode.",
        },
        text: {
          type: "string",
          description: "Text to encode or base64 string to decode.",
        },
      },
      required: ["text"],
    },
    handler
  );
}

export function makeGitWorktreeTool(): Tool {
  function handler(
    action?: string,
    name?: string,
    branch?: string
  ): string {
    const act = (action || "list").toLowerCase();
    const mgr = new GitWorktreeManager();

    try {
      switch (act) {
        case "add": {
          if (!name || !name.trim()) return "Error: 'name' is required for add.";
          const worktreePath = mgr.add(name.trim(), branch?.trim());
          return `Created worktree: ${name.trim()} at ${worktreePath}`;
        }
        case "remove": {
          if (!name || !name.trim()) return "Error: 'name' is required for remove.";
          return mgr.remove(name.trim());
        }
        case "list": {
          const worktrees = mgr.list();
          if (worktrees.length === 0) return "No worktrees found.";
          return worktrees
            .map(
              (w) =>
                `${w.isMain ? "(main) " : ""}${w.branch ?? "(detached)"} @ ${w.head.slice(0, 8)} — ${w.path}`
            )
            .join("\n");
        }
        case "switch": {
          if (!name || !name.trim()) return "Error: 'name' is required for switch.";
          const worktreePath = mgr.switch(name.trim());
          return `Switch to worktree by cd into: ${worktreePath}`;
        }
        case "prune": {
          const output = mgr.prune();
          return output.trim() === "" ? "Pruned stale worktrees (none found)." : `Pruned:\n${output.trim()}`;
        }
        default:
          return `Error: unknown action '${act}'. Valid: add, remove, list, switch, prune.`;
      }
    } catch (e: unknown) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return createTool(
    "git_worktree",
    "Manage git worktrees for parallel development. Actions: add (create), remove (delete), list (show all), switch (get path), prune (cleanup stale).",
    {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "remove", "list", "switch", "prune"],
          description: "Action to perform. Default 'list'.",
        },
        name: {
          type: "string",
          description: "Worktree name (required for add/remove/switch).",
        },
        branch: {
          type: "string",
          description: "Branch name for add (creates new branch). If omitted, defaults to worktree-<name>.",
        },
      },
    },
    handler
  );
}

// ── MCP Tool Wrappers ──────────────────────────────────────────

export function makeMcpToolWrapper(
  mcp: McpManager,
  toolInfo: McpToolInfo
): Tool {
  return createTool(
    `mcp_${toolInfo.serverName}_${toolInfo.name}`,
    `[MCP:${toolInfo.serverName}] ${toolInfo.description}`,
    toolInfo.inputSchema as ToolParameters,
    async (kwargs: Record<string, unknown>) => {
      return mcp.callTool(toolInfo.name, kwargs);
    }
  );
}

export function buildMcpTools(mcp: McpManager): Tool[] {
  return mcp.getTools().map((info) => makeMcpToolWrapper(mcp, info));
}

// ── Build All Tools ────────────────────────────────────────────

/**
 * Pipeline tool — execute a sequence of shell commands with output
 * interpolation, conditional steps, and structured results.
 */
export function makePipelineTool(): Tool {
  function handler(
    steps: unknown,
    name?: string
  ): string {
    if (!Array.isArray(steps) || steps.length === 0) {
      return "Error: 'steps' must be a non-empty array of step objects.";
    }

    const pipelineSteps: import("./pipeline.js").PipelineStep[] = [];
    for (let i = 0; i < steps.length; i++) {
      const raw = steps[i] as Record<string, unknown>;
      if (!raw || typeof raw !== "object") {
        return `Error: step ${i} is not an object.`;
      }
      if (typeof raw.name !== "string" || !raw.name.trim()) {
        return `Error: step ${i} is missing required 'name' field.`;
      }
      if (typeof raw.command !== "string" || !raw.command.trim()) {
        return `Error: step '${raw.name}' is missing required 'command' field.`;
      }

      const step: import("./pipeline.js").PipelineStep = {
        name: raw.name.trim(),
        command: raw.command.trim(),
      };

      if (raw.args && typeof raw.args === "object") {
        step.args = raw.args as Record<string, string>;
      }
      if (typeof raw.cwd === "string") {
        step.cwd = raw.cwd;
      }
      if (raw.env && typeof raw.env === "object") {
        step.env = raw.env as Record<string, string>;
      }
      if (typeof raw.continueOnError === "boolean") {
        step.continueOnError = raw.continueOnError;
      }
      if (typeof raw.if === "string") {
        step.if = raw.if;
      }

      pipelineSteps.push(step);
    }

    const engine = new PipelineEngine();
    const result = engine.execute(pipelineSteps, name);

    // Format result as a readable string
    const lines: string[] = [];
    const pipelineLabel = name ?? "unnamed";
    const pipelineOutcome = result.success ? "SUCCESS" : "FAILED";
    lines.push("Pipeline \"" + pipelineLabel + "\" -- " + pipelineOutcome);
    lines.push("");

    for (const step of result.steps) {
      const icon = step.status === "success" ? "✓" : step.status === "skipped" ? "○" : "✗";
      lines.push(`${icon} ${step.name} (${step.status}, ${step.duration}ms)`);
      if (step.error) {
        lines.push(`  Error: ${step.error}`);
      }
      if (step.output) {
        // Truncate very long outputs for readability
        const truncated =
          step.output.length > 500
            ? step.output.slice(0, 500) + `\n... (${step.output.length - 500} chars truncated)`
            : step.output;
        lines.push(`  ${truncated}`);
      }
    }

    return lines.join("\n");
  }

  return createTool(
    "pipeline",
    "Execute a pipeline of shell commands with output interpolation, conditional steps, and structured results. Each step can reference previous outputs via {stepName.output} or {stepName.exitCode}. Supports conditional execution via 'if' expressions.",
    {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Optional pipeline name for display in results.",
        },
        steps: {
          type: "string",
          description:
            "JSON array of step objects. Each step: { name: string, command: string, args?: object, cwd?: string, env?: object, continueOnError?: boolean, if?: string }",
        },
      },
      required: ["steps"],
    },
    handler
  );
}

// ── Killer Features: 4 New Tools ─────────────────────────────

/**
 * Refactoring Engine — analyzes code, generates plan, executes with validation.
 */
export function makeRefactoringEngineTool(): Tool {
  function handler(action?: string, filePath?: string): string {
    const engine = new RefactoringEngine();
    const act = (action || "analyze").toLowerCase();

    switch (act) {
      case "analyze": {
        if (!filePath) return "Error: 'filePath' is required for analyze action.";
        const metrics = engine.analyzeFile(filePath);
        return [
          `File: ${metrics.filePath}`,
          `Lines: ${metrics.lines}`,
          `Functions: ${metrics.functions}`,
          `Avg function length: ${metrics.avgFunctionLength.toFixed(1)}`,
          `Max function length: ${metrics.maxFunctionLength}`,
          `Complexity: ${metrics.complexity}`,
          `Duplication: ${(metrics.duplication * 100).toFixed(1)}%`,
          `Imports: ${metrics.dependencies.length}`,
          `Exports: ${metrics.exports.length}`,
        ].join("\n");
      }
      case "plan": {
        if (!filePath) return "Error: 'filePath' is required for plan action.";
        const plan = engine.generatePlan(filePath);
        if (plan.actions.length === 0) return "No refactoring needed for this file.";
        const lines = [
          `Refactoring plan for ${plan.filePath}`,
          `Total estimated lines: ${plan.totalEstimatedLines}`,
          "",
          ...plan.actions.map(
            (a) => `[${a.priority.toUpperCase()}] ${a.type}: ${a.description}`
          ),
        ];
        return lines.join("\n");
      }
      case "execute": {
        if (!filePath) return "Error: 'filePath' is required for execute action.";
        const plan = engine.generatePlan(filePath);
        if (plan.actions.length === 0) return "No refactoring needed.";
        const result = engine.executePlan(plan);
        return [
          `Refactoring ${result.applied ? "applied" : "not applied"}`,
          `Files modified: ${result.modifiedFiles.length}`,
          result.validation.success ? "Validation: PASSED" : "Validation: FAILED",
          result.validation.tscOutput ? `TSC: ${result.validation.tscOutput.slice(0, 200)}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      default:
        return `Error: unknown action '${act}'. Valid: analyze, plan, execute.`;
    }
  }

  return createTool(
    "refactor",
    "Autonomous refactoring engine. Analyzes code complexity, generates refactoring plan, and executes with validation. Actions: analyze (get metrics), plan (generate plan), execute (apply plan).",
    {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["analyze", "plan", "execute"],
          description: "Action to perform. Default 'analyze'.",
        },
        filePath: {
          type: "string",
          description: "Path to the file to analyze/refactor.",
        },
      },
    },
    handler
  );
}

/**
 * Multi-Agent Orchestrator — specialized agents working together.
 */
export function makeMultiAgentTool(): Tool {
  function handler(action?: string, task?: string, roles?: string): string {
    const orchestrator = new MultiAgentOrchestrator();
    const act = (action || "list").toLowerCase();

    switch (act) {
      case "list": {
        const agents = orchestrator.getAllAgents();
        return agents
          .map((a) => `${a.role}: ${a.description} [${a.expertise.join(", ")}]`)
          .join("\n");
      }
      case "suggest": {
        if (!task) return "Error: 'task' is required for suggest action.";
        const suggested = orchestrator.suggestRoles(task);
        if (suggested.length === 0) return "No specific roles suggested for this task.";
        return `Suggested roles: ${suggested.join(", ")}`;
      }
      case "describe": {
        if (!roles) return "Error: 'roles' is required for describe action.";
        const roleList = roles.split(",").map((r) => r.trim()) as import("./multi-agent.js").AgentRole[];
        const descriptions = roleList.map((r) => {
          const agent = orchestrator.getAgent(r);
          if (!agent) return `${r}: unknown role`;
          return `${agent.role}: ${agent.description}\n  Expertise: ${agent.expertise.join(", ")}\n  Tools: ${agent.tools.join(", ")}\n  Constraints: ${agent.constraints.join(", ")}`;
        });
        return descriptions.join("\n\n");
      }
      default:
        return `Error: unknown action '${act}'. Valid: list, suggest, describe.`;
    }
  }

  return createTool(
    "multi_agent",
    "Multi-agent orchestration system with specialized agents. Actions: list (show all agents), suggest (recommend roles for task), describe (show agent details).",
    {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "suggest", "describe"],
          description: "Action to perform. Default 'list'.",
        },
        task: {
          type: "string",
          description: "Task description to get role suggestions (for 'suggest' action).",
        },
        roles: {
          type: "string",
          description: "Comma-separated roles to describe (for 'describe' action). E.g. 'frontend,backend'.",
        },
      },
    },
    handler
  );
}

/**
 * Time Machine — snapshot, restore, diff, branch codebase states.
 */
export function makeTimeMachineTool(): Tool {
  function handler(
    action?: string,
    snapshotId?: string,
    description?: string,
    filePaths?: string,
    snapshotId2?: string,
    branch?: string
  ): string {
    const tm = new TimeMachine(process.cwd());
    const act = (action || "list").toLowerCase();

    try {
      switch (act) {
        case "snapshot": {
          const desc = description ?? `Snapshot at ${new Date().toISOString()}`;
          const files = filePaths
            ? filePaths.split(",").map((f) => f.trim())
            : [];
          if (files.length === 0) return "Error: 'filePaths' is required for snapshot action.";
          const snapshot = tm.createSnapshot(desc, files);
          return `Created snapshot ${snapshot.id} with ${snapshot.files.length} files.`;
        }
        case "restore": {
          if (!snapshotId) return "Error: 'snapshotId' is required for restore action.";
          const result = tm.restoreSnapshot(snapshotId);
          return `Restored ${result.restored.length} files from snapshot ${snapshotId}.`;
        }
        case "list": {
          const snapshots = tm.listSnapshots();
          if (snapshots.length === 0) return "No snapshots found.";
          return snapshots
            .map(
              (s) =>
                `${s.id} — ${s.description} (${s.files.length} files, ${s.timestamp})`
            )
            .join("\n");
        }
        case "diff": {
          if (!snapshotId || !snapshotId2)
            return "Error: 'snapshotId' and 'snapshotId2' are required for diff.";
          const diff = tm.compareSnapshots(snapshotId, snapshotId2);
          const lines = [
            `Comparing ${snapshotId} → ${snapshotId2}`,
            `Added: ${diff.added.length}`,
            `Removed: ${diff.removed.length}`,
            `Modified: ${diff.modified.length}`,
            `Unchanged: ${diff.unchanged.length}`,
          ];
          if (diff.added.length > 0) lines.push(`  + ${diff.added.join(", ")}`);
          if (diff.removed.length > 0) lines.push(`  - ${diff.removed.join(", ")}`);
          if (diff.modified.length > 0) lines.push(`  ~ ${diff.modified.join(", ")}`);
          return lines.join("\n");
        }
        case "branch": {
          if (!branch) return "Error: 'branch' is required for branch action.";
          tm.createBranch(branch, snapshotId);
          return `Created branch '${branch}'${snapshotId ? ` from snapshot ${snapshotId}` : ""}.`;
        }
        case "branches": {
          const branches = tm.listBranches();
          if (branches.length === 0) return "No branches found.";
          return `Branches:\n${branches.join("\n")}`;
        }
        case "delete": {
          if (!snapshotId) return "Error: 'snapshotId' is required for delete action.";
          tm.deleteSnapshot(snapshotId);
          return `Deleted snapshot ${snapshotId}.`;
        }
        default:
          return `Error: unknown action '${act}'. Valid: snapshot, restore, list, diff, branch, branches, delete.`;
      }
    } catch (e: unknown) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return createTool(
    "time_machine",
    "Codebase time machine — record states, restore, diff, branch. Actions: snapshot (create), restore, list, diff (compare two), branch, branches, delete.",
    {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["snapshot", "restore", "list", "diff", "branch", "branches", "delete"],
          description: "Action to perform. Default 'list'.",
        },
        snapshotId: {
          type: "string",
          description: "Snapshot ID (required for restore, diff, delete).",
        },
        description: {
          type: "string",
          description: "Description for new snapshot (for 'snapshot' action).",
        },
        filePaths: {
          type: "string",
          description: "Comma-separated file paths to snapshot (for 'snapshot' action).",
        },
        snapshotId2: {
          type: "string",
          description: "Second snapshot ID for comparison (for 'diff' action).",
        },
        branch: {
          type: "string",
          description: "Branch name (for 'branch' action).",
        },
      },
    },
    handler
  );
}

/**
 * Predictive Bug Detector — scans code for likely bugs and suggests fixes.
 */
export function makePredictiveBugsTool(): Tool {
  function handler(action?: string, filePath?: string, dirPath?: string): string {
    const detector = new PredictiveBugDetector();
    const act = (action || "scan").toLowerCase();

    switch (act) {
      case "scan": {
        if (!filePath) return "Error: 'filePath' is required for scan action.";
        const reports = detector.scanFile(filePath);
        if (reports.length === 0) return `No bugs found in ${filePath}.`;
        const summary = detector.getSeveritySummary(reports);
        const lines = [
          `Found ${reports.length} potential issues in ${filePath}:`,
          `  Critical: ${summary.critical}, High: ${summary.high}, Medium: ${summary.medium}, Low: ${summary.low}`,
          "",
          ...reports.slice(0, 20).map(
            (r) =>
              `[${r.pattern.severity.toUpperCase()}] L${r.line}:${r.column} — ${r.pattern.name}\n    ${r.suggestion}`
          ),
        ];
        if (reports.length > 20) lines.push(`\n... and ${reports.length - 20} more`);
        return lines.join("\n");
      }
      case "scan-dir": {
        if (!dirPath) return "Error: 'dirPath' is required for scan-dir action.";
        const reports = detector.scanDirectory(dirPath);
        if (reports.length === 0) return `No bugs found in ${dirPath}.`;
        const summary = detector.getSeveritySummary(reports);
        return [
          `Found ${reports.length} potential issues in ${dirPath}:`,
          `  Critical: ${summary.critical}, High: ${summary.high}, Medium: ${summary.medium}, Low: ${summary.low}`,
          "",
          ...reports.slice(0, 30).map(
            (r) =>
              `[${r.pattern.severity.toUpperCase()}] ${r.file}:${r.line} — ${r.pattern.name}`
          ),
          reports.length > 30 ? `\n... and ${reports.length - 30} more` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      case "patterns": {
        const patterns = detector.getPatterns();
        return patterns
          .map((p) => `[${p.severity}] ${p.id}: ${p.name} (${p.category})`)
          .join("\n");
      }
      default:
        return `Error: unknown action '${act}'. Valid: scan, scan-dir, patterns.`;
    }
  }

  return createTool(
    "predict_bugs",
    "Predictive bug detector — scans code for likely bugs before they cause issues. Actions: scan (single file), scan-dir (recursive), patterns (list all patterns).",
    {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["scan", "scan-dir", "patterns"],
          description: "Action to perform. Default 'scan'.",
        },
        filePath: {
          type: "string",
          description: "File to scan (for 'scan' action).",
        },
        dirPath: {
          type: "string",
          description: "Directory to scan recursively (for 'scan-dir' action).",
        },
      },
    },
    handler
  );
}

export function buildTools(
  mode: string,
  depth: number,
  log: LogFn,
  runAgentFn: (
    task: string,
    mode: string,
    depth: number,
    log: LogFn
  ) => Promise<string>,
  taskProvider?: TaskProvider,
  mcp?: McpManager
): Map<string, Tool> {
  const readOnly = mode === "plan";
  const toolList: Tool[] = [
    makeBashTool(readOnly),
    makeReadFileTool(),
    makeListFilesTool(),
    makeGrepTool(),
    makeGitStatusTool(),
    makeGitDiffTool(),
    makeGitWorktreeTool(),
    makeWebFetchTool(),
    // New read-only tools (always available)
    makeHttpRequestTool(),
    makeJsonQueryTool(),
    makeEnvReadTool(),
    makeFileInfoTool(),
    makeTreeTool(),
    makeHashTool(),
    makeBase64Tool(),
    // Killer features — always available
    makeRefactoringEngineTool(),
    makeMultiAgentTool(),
    makeTimeMachineTool(),
    makePredictiveBugsTool(),
  ];

  // Todo tool always available (read-only operations are non-destructive).
  if (taskProvider) {
    toolList.push(makeTodoListTool(taskProvider));
  }

  if (!readOnly) {
    toolList.push(makeWriteFileTool());
    toolList.push(makeEditFileTool());
    // Destructive tools (blocked in Plan mode)
    toolList.push(makeCopyFileTool());
    toolList.push(makeMoveFileTool());
    toolList.push(makeDiffApplyTool());
    // Pipeline tool (executes shell commands)
    toolList.push(makePipelineTool());
  }

  if (depth < MAX_SUBAGENT_DEPTH) {
    toolList.push(makeDelegateTool(depth, log, runAgentFn));
    toolList.push(makeSpawnParallelTool(depth, log, runAgentFn));
  }

  // MCP tools — appended at the end
  if (mcp) {
    toolList.push(...buildMcpTools(mcp));
  }

  // Custom tools — loaded from .klyxor/tools/*.json, appended after MCP tools
  if (getCustomToolsEnabled()) {
    const loader = new CustomToolLoader();
    toolList.push(...loader.loadTools());
  }

  const map = new Map<string, Tool>();
  for (const t of toolList) {
    map.set(t.name, t);
  }
  return map;
}
