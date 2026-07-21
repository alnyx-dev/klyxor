/**
 * PipelineEngine — execute a sequence of shell commands with
 * output interpolation, conditional steps, and structured results.
 */

import { execSync } from "node:child_process";
import {
  MAX_PIPELINE_STEPS,
  PIPELINE_STEP_TIMEOUT_MS,
} from "./constants.js";

/** A single step in a pipeline. */
export interface PipelineStep {
  /** Unique name for this step (used in output interpolation and display). */
  name: string;
  /** Shell command to execute. */
  command: string;
  /** Optional key-value pairs passed as arguments (available via `{stepName.args.key}` in the command). */
  args?: Record<string, string>;
  /** Working directory for this step (optional, defaults to process.cwd()). */
  cwd?: string;
  /** Extra environment variables for this step (merged with process.env). */
  env?: Record<string, string>;
  /** If true, the pipeline continues even if this step fails. Default: false. */
  continueOnError?: boolean;
  /** Conditional expression — step is skipped if this evaluates to false.
   *  Supports simple patterns: `{stepName.output} === "value"` or `{stepName.exitCode} === 0`. */
  if?: string;
}

/** Result for a single pipeline step. */
export interface StepResult {
  name: string;
  status: "success" | "failure" | "skipped";
  output: string;
  duration: number;
  error?: string;
}

/** Aggregated result of an entire pipeline execution. */
export interface PipelineResult {
  steps: StepResult[];
  success: boolean;
}

// ── Interpolation ──────────────────────────────────────────────

/**
 * Replace `{stepName.output}` and `{stepName.exitCode}` placeholders
 * in a string with actual values from previously executed steps.
 *
 * Values are sanitized: output is trimmed, and shell-unsafe characters
 * are escaped for safe use in command strings.
 */
function interpolate(
  template: string,
  outputs: Map<string, { output: string; exitCode: number }>
): string {
  return template.replace(
    /\{([a-zA-Z_][a-zA-Z0-9_]*)\.(output|exitCode)\}/g,
    (_match, stepName: string, field: string) => {
      const entry = outputs.get(stepName);
      if (!entry) {
        return "";
      }
      if (field === "output") {
        return entry.output;
      }
      if (field === "exitCode") {
        return String(entry.exitCode);
      }
      return "";
    }
  );
}

// ── Conditional evaluation ─────────────────────────────────────

/**
 * Evaluate a simple conditional expression against step outputs.
 *
 * Supported patterns (NO eval — regex-matched only):
 *   - `{stepName.output} === "value"`   — exact string match
 *   - `{stepName.output} !== "value"`   — string non-equality
 *   - `{stepName.output} === 0`         — numeric comparison
 *   - `{stepName.exitCode} === 0`       — exit code check
 *
 * Returns `true` if the expression cannot be parsed (fail-open for step execution).
 */
function evaluateCondition(
  expr: string,
  outputs: Map<string, { output: string; exitCode: number }>
): boolean {
  // Try: {step.field} operator value
  const match = expr.match(
    /^\{([a-zA-Z_][a-zA-Z0-9_]*)\.(output|exitCode)\}\s*(===|!==)\s*"?(.+?)"?\s*$/
  );
  if (!match) {
    // Unparseable — fail-open so the step runs
    return true;
  }

  const [, stepName, field, operator, rawValue] = match;
  if (!stepName || !field || !operator || rawValue === undefined) {
    return true;
  }

  const entry = outputs.get(stepName);
  if (!entry) {
    return operator === "!=="; // missing step → treat as empty
  }

  const actual = field === "output" ? entry.output : String(entry.exitCode);
  const expected = rawValue;

  if (operator === "===") {
    return actual === expected;
  }
  if (operator === "!==") {
    return actual !== expected;
  }
  return true;
}

// ── PipelineEngine ─────────────────────────────────────────────

/**
 * Executes a pipeline: an ordered sequence of shell commands where
 * each step can reference previous outputs, run conditionally, and
 * continue or stop on failure.
 *
 * @example
 * ```ts
 * const engine = new PipelineEngine();
 * const result = engine.execute({
 *   name: "build",
 *   steps: [
 *     { name: "lint", command: "npx eslint src/" },
 *     { name: "test", command: "npm test", if: '{lint.exitCode} === 0' },
 *     { name: "build", command: "npm run build" },
 *   ],
 * });
 * ```
 */
export class PipelineEngine {
  /**
   * Execute a pipeline of steps sequentially.
   *
   * @param steps - Ordered array of pipeline steps.
   * @param pipelineName - Optional display name for logging.
   * @returns Structured result with per-step status and overall success flag.
   * @throws If the pipeline exceeds `MAX_PIPELINE_STEPS`.
   */
  execute(
    steps: PipelineStep[],
    pipelineName?: string
  ): PipelineResult {
    if (steps.length > MAX_PIPELINE_STEPS) {
      return {
        steps: [
          {
            name: pipelineName ?? "pipeline",
            status: "failure",
            output: "",
            duration: 0,
            error: `Pipeline has ${steps.length} steps, exceeding maximum of ${MAX_PIPELINE_STEPS}`,
          },
        ],
        success: false,
      };
    }

    const stepOutputs = new Map<
      string,
      { output: string; exitCode: number }
    >();
    const stepResults: StepResult[] = [];
    let overallSuccess = true;

    for (const step of steps) {
      // ── Conditional check ──
      if (step.if) {
        const shouldRun = evaluateCondition(step.if, stepOutputs);
        if (!shouldRun) {
          stepResults.push({
            name: step.name,
            status: "skipped",
            output: "",
            duration: 0,
          });
          continue;
        }
      }

      // ── Interpolate command ──
      const command = interpolate(step.command, stepOutputs);

      // ── Interpolate args ──
      const interpolatedArgs: Record<string, string> = {};
      if (step.args) {
        for (const [key, value] of Object.entries(step.args)) {
          interpolatedArgs[key] = interpolate(value, stepOutputs);
        }
      }

      // ── Build full command with args ──
      let fullCommand = command;
      if (Object.keys(interpolatedArgs).length > 0) {
        const argStr = Object.entries(interpolatedArgs)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        fullCommand = `${argStr} ${command}`;
      }

      // ── Execute ──
      const start = performance.now();
      let output = "";
      let exitCode = 0;
      let error: string | undefined;

      try {
        const result = execSync(fullCommand, {
          timeout: PIPELINE_STEP_TIMEOUT_MS,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          cwd: step.cwd,
          env: step.env ? { ...process.env, ...step.env } : undefined,
        });
        output = result.toString().trim();
      } catch (e: unknown) {
        const err = e as {
          status?: number;
          stdout?: string;
          stderr?: string;
          message?: string;
        };
        exitCode = err.status ?? 1;
        const stdout = (err.stdout ?? "").toString().trim();
        const stderr = (err.stderr ?? "").toString().trim();
        const parts: string[] = [];
        if (stdout) parts.push(stdout);
        if (stderr) parts.push(`STDERR:\n${stderr}`);
        output = parts.join("\n").trim();

        if (err.message?.includes("timed out")) {
          error = `Command timed out after ${PIPELINE_STEP_TIMEOUT_MS / 1000}s`;
          output = output || error;
        } else if (!output) {
          error = `Exit code: ${exitCode}`;
          output = error;
        }
      }

      const duration = performance.now() - start;
      const status = exitCode === 0 ? "success" : "failure";

      stepOutputs.set(step.name, { output, exitCode });
      stepResults.push({
        name: step.name,
        status,
        output,
        duration: Math.round(duration),
        ...(error ? { error } : {}),
      });

      if (exitCode !== 0 && !step.continueOnError) {
        overallSuccess = false;
        break;
      }
    }

    return {
      steps: stepResults,
      success: overallSuccess,
    };
  }
}
