import fs from "node:fs";
import path from "node:path";
import { PROJECT_CONTEXT_FILES } from "./constants.js";

/** Max characters read from any single context file (guards huge files). */
const MAX_CONTEXT_FILE_CHARS = 12_000;

let _cache: string | null | undefined;

/**
 * Load project-specific context from well-known files (AGENTS.md, KLYXOR.md,
 * .klyxor/context.md) relative to the current working directory. Returns a
 * single concatenated string with per-file headers, or "" if none exist.
 *
 * Result is cached per process; call reloadProjectContext() to invalidate.
 */
export function loadProjectContext(cwd: string = process.cwd()): string {
  if (_cache !== undefined && _cache !== null) return _cache;

  const sections: string[] = [];
  for (const rel of PROJECT_CONTEXT_FILES) {
    const full = path.resolve(cwd, rel);
    try {
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
      let body = fs.readFileSync(full, "utf-8").trim();
      if (!body) continue;
      if (body.length > MAX_CONTEXT_FILE_CHARS) {
        body = body.slice(0, MAX_CONTEXT_FILE_CHARS) + "\n…[truncated]";
      }
      sections.push(`## Project context: ${rel}\n\n${body}`);
    } catch {
      // Ignore unreadable files.
    }
  }

  _cache = sections.length > 0 ? sections.join("\n\n") : "";
  return _cache;
}

/** Invalidate the cached project context (e.g. after files change). */
export function reloadProjectContext(): void {
  _cache = undefined;
}

/**
 * Append project context to a base system prompt, if any context exists.
 */
export function withProjectContext(basePrompt: string): string {
  const ctx = loadProjectContext();
  if (!ctx) return basePrompt;
  return `${basePrompt}\n\n---\n\n${ctx}`;
}
