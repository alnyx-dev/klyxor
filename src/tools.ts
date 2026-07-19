import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { MAX_SUBAGENT_DEPTH } from "./constants.js";
import {
  BASH_TIMEOUT_MS,
  DEFAULT_READ_FILE_LIMIT,
  MAX_LIST_FILES_RESULTS,
  MAX_GREP_RESULTS,
  PREVIEW,
  SKIP_DIRS,
  MODE_PLAN,
  MODE_BUILD,
  WEB_FETCH_MAX_CHARS,
  WEB_FETCH_TIMEOUT_MS,
} from "./constants.js";

export type LogFn = (msg: string) => void;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => string | Promise<string>;

export function createTool(
  name: string,
  description: string,
  parameters: ToolParameters,
  handler: Handler
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
      return handler(...args);
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

      function walk(dir: string, rel: string): void {
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

export function makeGrepTool(): Tool {
  function handler(
    pattern: string,
    searchPath?: string,
    include?: string
  ): string {
    const base = searchPath || ".";
    const results: string[] = [];
    const regex = new RegExp(pattern);
    const skipDirs = SKIP_DIRS;

    function walk(dir: string): void {
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
  taskProvider?: TaskProvider
): Map<string, Tool> {
  const readOnly = mode === "plan";
  const toolList: Tool[] = [
    makeBashTool(readOnly),
    makeReadFileTool(),
    makeListFilesTool(),
    makeGrepTool(),
    makeGitStatusTool(),
    makeGitDiffTool(),
    makeWebFetchTool(),
  ];

  // Todo tool always available (read-only operations are non-destructive).
  if (taskProvider) {
    toolList.push(makeTodoListTool(taskProvider));
  }

  if (!readOnly) {
    toolList.push(makeWriteFileTool());
    toolList.push(makeEditFileTool());
  }

  if (depth < MAX_SUBAGENT_DEPTH) {
    toolList.push(makeDelegateTool(depth, log, runAgentFn));
  }

  const map = new Map<string, Tool>();
  for (const t of toolList) {
    map.set(t.name, t);
  }
  return map;
}
