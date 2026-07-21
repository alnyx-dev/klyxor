/**
 * Parallel subagent execution pool.
 *
 * Runs multiple subagent tasks concurrently using `Promise.allSettled()`,
 * collecting per-task results with success/failure status. Respects
 * MAX_SUBAGENT_DEPTH to prevent infinite recursion.
 */

import {
  MAX_PARALLEL_AGENTS,
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_POOL_TIMEOUT_MS,
  MODE_PLAN,
  MODE_BUILD,
  PREVIEW,
} from "./constants.js";
import type { LogFn } from "./tools.js";

/** A single task submitted to the pool. */
export interface PoolTask {
  /** Self-contained task description for the subagent. */
  task: string;
  /** Execution mode: "plan" (read-only) or "build" (full access). Default "build". */
  mode?: string;
}

/** Result for a single task after pool execution. */
export interface PoolTaskResult {
  /** Index of the task in the original input array. */
  index: number;
  /** The original task description. */
  task: string;
  /** Execution mode used. */
  mode: string;
  /** "success" or "failure". */
  status: "success" | "failure";
  /** The agent's final answer string (present on success). */
  result?: string;
  /** Error message (present on failure). */
  error?: string;
}

/** Aggregated result from running all tasks in the pool. */
export interface PoolResult {
  /** Per-task results in the same order as the input. */
  results: PoolTaskResult[];
  /** Number of tasks that succeeded. */
  succeeded: number;
  /** Number of tasks that failed. */
  failed: number;
  /** Total tasks submitted. */
  total: number;
}

/**
 * Manages parallel execution of multiple subagent tasks.
 *
 * Usage:
 * ```ts
 * const pool = new SubagentPool(depth, log, runAgentFn);
 * const result = await pool.run([
 *   { task: "investigate module A" },
 *   { task: "write tests for module B", mode: "build" },
 * ]);
 * ```
 */
export class SubagentPool {
  private readonly depth: number;
  private readonly log: LogFn;
  private readonly runAgentFn: (
    task: string,
    mode: string,
    depth: number,
    log: LogFn
  ) => Promise<string>;

  /**
   * Create a new SubagentPool.
   * @param depth - Current delegation depth (parent agent's depth).
   * @param log - Logging function for status messages.
   * @param runAgentFn - The `runAgent` function to execute each task.
   */
  constructor(
    depth: number,
    log: LogFn,
    runAgentFn: (
      task: string,
      mode: string,
      depth: number,
      log: LogFn
    ) => Promise<string>
  ) {
    this.depth = depth;
    this.log = log;
    this.runAgentFn = runAgentFn;
  }

  /**
   * Run all tasks in parallel and return aggregated results.
   *
   * @param tasks - Array of tasks to execute (max MAX_PARALLEL_AGENTS).
   * @returns Aggregated pool results with per-task status.
   */
  async run(tasks: PoolTask[]): Promise<PoolResult> {
    if (tasks.length === 0) {
      return { results: [], succeeded: 0, failed: 0, total: 0 };
    }

    if (tasks.length > MAX_PARALLEL_AGENTS) {
      throw new Error(
        `Too many parallel tasks: ${tasks.length} (max ${MAX_PARALLEL_AGENTS}).`
      );
    }

    if (this.depth >= MAX_SUBAGENT_DEPTH) {
      throw new Error(
        `Cannot spawn parallel agents: max delegation depth (${MAX_SUBAGENT_DEPTH}) reached.`
      );
    }

    const childDepth = this.depth + 1;

    this.log(
      `↳ spawning ${tasks.length} parallel subagent(s) at depth ${childDepth}`
    );

    const settled = await Promise.allSettled(
      tasks.map(async (task, index): Promise<PoolTaskResult> => {
        const actualMode =
          task.mode === MODE_PLAN || task.mode === MODE_BUILD
            ? task.mode
            : MODE_BUILD;

        this.log(
          `  ↳ [${index}] delegating (mode=${actualMode}): ${task.task.slice(0, PREVIEW.task)}`
        );

        try {
          const result = await this.runAgentFn(
            task.task,
            actualMode,
            childDepth,
            this.log
          );
          return {
            index,
            task: task.task,
            mode: actualMode,
            status: "success",
            result,
          };
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          return {
            index,
            task: task.task,
            mode: actualMode,
            status: "failure",
            error: message,
          };
        }
      })
    );

    const results: PoolTaskResult[] = settled.map((entry, index) => {
      if (entry.status === "fulfilled") {
        return entry.value;
      }
      // entry.status === "rejected" — promise itself threw before returning
      const message =
        entry.reason instanceof Error
          ? entry.reason.message
          : String(entry.reason);
      return {
        index,
        task: tasks[index]!.task,
        mode:
          tasks[index]!.mode === MODE_PLAN ||
          tasks[index]!.mode === MODE_BUILD
            ? tasks[index]!.mode!
            : MODE_BUILD,
        status: "failure",
        error: message,
      };
    });

    const succeeded = results.filter((r) => r.status === "success").length;
    const failed = results.filter((r) => r.status === "failure").length;

    this.log(
      `↳ parallel pool complete: ${succeeded} succeeded, ${failed} failed (${results.length} total)`
    );

    return { results, succeeded, failed, total: results.length };
  }

  /**
   * Format pool results into a readable summary string.
   *
   * @param result - The PoolResult from a run() call.
   * @returns Formatted multi-line string with per-task results.
   */
  static formatResult(result: PoolResult): string {
    const lines: string[] = [
      `Parallel execution complete: ${result.succeeded}/${result.total} succeeded`,
      "",
    ];

    for (const r of result.results) {
      const icon = r.status === "success" ? "✓" : "✗";
      lines.push(`${icon} [${r.index}] (${r.mode}) ${r.task.slice(0, 80)}`);
      if (r.status === "success" && r.result) {
        // Indent the result and cap length for readability
        const preview = r.result.length > 500
          ? r.result.slice(0, 500) + "…"
          : r.result;
        lines.push(`  ${preview}`);
      } else if (r.status === "failure" && r.error) {
        lines.push(`  Error: ${r.error}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
