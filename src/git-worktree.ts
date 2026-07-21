/**
 * Git worktree management for parallel development workflows.
 *
 * Provides a GitWorktreeManager class for creating, listing, removing, and
 * switching between git worktrees — enabling parallel work on multiple branches
 * without stashing or switching.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { BASH_TIMEOUT_MS, GIT_WORKTREE_BASE_DIR } from "./constants.js";

/**
 * Metadata for a single git worktree.
 */
export interface GitWorktreeInfo {
  /** Absolute path to the worktree directory */
  path: string;
  /** Branch the worktree is on */
  branch: string;
  /** HEAD commit SHA */
  head: string;
  /** Whether this is the main (bare) worktree */
  isMain: boolean;
}

/**
 * Manages git worktrees within a repository.
 *
 * Creates worktrees under a configurable base directory (default: `.klyxor/worktrees`)
 * and provides methods for adding, removing, listing, switching, and pruning worktrees.
 */
export class GitWorktreeManager {
  private readonly baseDir: string;
  private readonly cwd: string;

  /**
   * Create a new GitWorktreeManager.
   * @param cwd - The project root (repository root). Defaults to process.cwd().
   * @param baseDir - Relative path for worktrees under cwd. Defaults to GIT_WORKTREE_BASE_DIR.
   */
  constructor(cwd?: string, baseDir?: string) {
    this.cwd = cwd ?? process.cwd();
    this.baseDir = path.resolve(this.cwd, baseDir ?? GIT_WORKTREE_BASE_DIR);
  }

  /**
   * Execute a git command synchronously and return stdout, or throw on failure.
   */
  private git(args: string): string {
    try {
      return execSync(`git ${args}`, {
        cwd: this.cwd,
        timeout: BASH_TIMEOUT_MS,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: unknown) {
      const err = e as {
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const stderr = String(err.stderr ?? "").trim();
      const stdout = String(err.stdout ?? "").trim();
      if (err.message?.includes("timed out")) {
        throw new Error(`git command timed out after ${BASH_TIMEOUT_MS / 1000}s`);
      }
      throw new Error(stderr || stdout || `git command failed (exit ${err.status ?? 1})`);
    }
  }

  /**
   * Sanitize a worktree name to prevent path traversal or shell injection.
   */
  private sanitizeName(name: string): string {
    const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, "-");
    if (!sanitized || sanitized.length === 0) {
      throw new Error(`Invalid worktree name: "${name}"`);
    }
    return sanitized;
  }

  /**
   * Create a new worktree.
   * @param name - Short name for the worktree (used as directory name and branch name if branch omitted).
   * @param branch - Optional branch name to check out. If omitted, creates a new branch from HEAD.
   * @returns The absolute path to the new worktree.
   */
  add(name: string, branch?: string): string {
    const safe = this.sanitizeName(name);
    const worktreePath = path.join(this.baseDir, safe);

    // Ensure the base directory exists
    mkdirSync(this.baseDir, { recursive: true });

    const branchFlag = branch ?? `worktree-${safe}`;
    this.git(`worktree add -b ${branchFlag} ${worktreePath}`);
    return worktreePath;
  }

  /**
   * Remove an existing worktree.
   * @param name - The worktree name (directory name under the base dir).
   * @returns Success message.
   */
  remove(name: string): string {
    const safe = this.sanitizeName(name);
    const worktreePath = path.join(this.baseDir, safe);

    this.git(`worktree remove --force ${worktreePath}`);
    return `Removed worktree: ${safe}`;
  }

  /**
   * List all worktrees in the repository.
   * @returns Array of GitWorktreeInfo objects.
   */
  list(): GitWorktreeInfo[] {
    const output = this.git("worktree list --porcelain");
    const lines = output.split("\n").filter((l) => l.trim() !== "");

    const worktrees: GitWorktreeInfo[] = [];
    let current: Partial<GitWorktreeInfo> = {};

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        // Flush previous entry
        if (current.path) {
          worktrees.push(current as GitWorktreeInfo);
        }
        current = {
          path: line.slice("worktree ".length).trim(),
          isMain: false,
        };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length).trim();
      } else if (line === "bare") {
        current.isMain = true;
      }
    }
    // Flush last entry
    if (current.path) {
      worktrees.push(current as GitWorktreeInfo);
    }

    return worktrees;
  }

  /**
   * Switch to a worktree by returning its path.
   * @param name - The worktree name (directory name under the base dir).
   * @returns The absolute path to the worktree.
   */
  switch(name: string): string {
    const safe = this.sanitizeName(name);
    const worktreePath = path.join(this.baseDir, safe);

    // Verify the worktree exists
    if (!existsSync(worktreePath)) {
      throw new Error(`Worktree "${safe}" not found at ${worktreePath}`);
    }
    return worktreePath;
  }

  /**
   * Clean up stale worktree references.
   * @returns Output from git worktree prune.
   */
  prune(): string {
    return this.git("worktree prune");
  }
}
