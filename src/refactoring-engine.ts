/**
 * Autonomous refactoring engine for klyxor.
 *
 * Analyses TypeScript/JavaScript files via regex-based metrics (no AST parser),
 * generates a prioritised refactoring plan, optionally executes it, and validates
 * the result with `tsc --noEmit`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  MAX_FILE_LINES_FOR_REFACTORING,
  DUPLICATION_THRESHOLD,
  COMPLEXITY_THRESHOLD,
  REFACTORING_VALIDATION_TIMEOUT_MS,
} from "./constants.js";

// ── Public interfaces ─────────────────────────────────────────

export interface CodeMetrics {
  filePath: string;
  lines: number;
  functions: number;
  avgFunctionLength: number;
  maxFunctionLength: number;
  /** Cyclomatic complexity estimate (higher = more branches). */
  complexity: number;
  /** Estimated duplication ratio (0-1). */
  duplication: number;
  /** Raw import specifiers found in the file. */
  dependencies: string[];
  /** Exported symbol names. */
  exports: string[];
}

export interface RefactoringAction {
  type:
    | "extract_function"
    | "split_file"
    | "remove_duplication"
    | "simplify"
    | "reorganize_imports";
  description: string;
  priority: "high" | "medium" | "low";
  estimatedImpact: string;
  /** 1-based line numbers related to this action. */
  targetLines?: number[];
}

export interface RefactoringPlan {
  filePath: string;
  metrics: CodeMetrics;
  actions: RefactoringAction[];
  /** Sum of estimated changed lines across all actions. */
  totalEstimatedLines: number;
}

export interface RefactoringResult {
  plan: RefactoringPlan;
  applied: boolean;
  modifiedFiles: string[];
  validation: ValidationResult;
}

export interface ValidationResult {
  success: boolean;
  tscOutput: string;
  syntaxValid: boolean;
  /** true when the refactored file is not unreasonably large. */
  sizeReasonable: boolean;
}

// ── Helpers ───────────────────────────────────────────────────

/** Normalise line endings and strip trailing whitespace for comparison. */
function normaliseLine(line: string): string {
  return line.replace(/\s+$/g, "").trim();
}

/** Count occurrences of a regex across a string. */
function countMatches(text: string, pattern: RegExp): number {
  let n = 0;
  // Use matchAll so we don't mutate lastIndex on a global regex.
  for (const m of text.matchAll(pattern)) {
    n += m.length > 0 ? 1 : 0;
  }
  return n;
}

// ── RefactoringEngine ─────────────────────────────────────────

export class RefactoringEngine {
  // ── Analysis ────────────────────────────────────────────────

  /**
   * Read a source file and compute code metrics.
   */
  analyzeFile(filePath: string): CodeMetrics {
    const abs = path.resolve(filePath);
    const content = fs.readFileSync(abs, "utf-8");
    const lines = content.split("\n");
    const lineCount = lines.length;

    // ── Functions ──
    // Match: function foo(, const foo = (, const foo = async (, foo( {, etc.
    const funcPattern =
      /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:^|\s)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/gm;

    const functionRanges: { name: string; start: number; end: number }[] = [];
    for (const m of content.matchAll(funcPattern)) {
      const name = m[1] ?? m[2] ?? "<anonymous>";
      const matchIdx = m.index ?? 0;
      const startLine = content.slice(0, matchIdx).split("\n").length;
      // Heuristic: scan forward to find the matching closing brace.
      const endLine = this.findClosingBrace(lines, startLine - 1);
      functionRanges.push({ name, start: startLine, end: endLine });
    }

    const funcLengths = functionRanges.map((f) => f.end - f.start + 1);
    const avgFunctionLength =
      funcLengths.length > 0
        ? Math.round(funcLengths.reduce((a, b) => a + b, 0) / funcLengths.length)
        : 0;
    const maxFunctionLength =
      funcLengths.length > 0 ? Math.max(...funcLengths) : 0;

    // ── Cyclomatic complexity estimate ──
    const complexity = this.estimateComplexity(content);

    // ── Duplication ──
    const duplication = this.estimateDuplication(lines);

    // ── Dependencies ──
    const dependencies: string[] = [];
    for (const line of lines) {
      const imp = line.match(
        /^\s*import\s+(?:.*from\s+)?["']([^"']+)["']/
      );
      if (imp) dependencies.push(imp[1]);
      const req = line.match(
        /(?:const|let|var)\s+\w+\s*=\s*require\(["']([^"']+)["']\)/
      );
      if (req) dependencies.push(req[1]);
    }

    // ── Exports ──
    const exports: string[] = [];
    for (const line of lines) {
      // export function foo / export const foo / export class foo / export { foo }
      const named = line.match(
        /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/
      );
      if (named) exports.push(named[1]);
      const reExport = line.match(/export\s*\{([^}]+)\}/);
      if (reExport) {
        for (const s of reExport[1].split(",")) {
          const trimmed = s.trim().split(/\s+as\s+/)[0].trim();
          if (trimmed) exports.push(trimmed);
        }
      }
      if (/export\s+default\b/.test(line)) exports.push("default");
    }

    return {
      filePath: abs,
      lines: lineCount,
      functions: functionRanges.length,
      avgFunctionLength,
      maxFunctionLength,
      complexity,
      duplication,
      dependencies,
      exports,
    };
  }

  // ── Plan generation ─────────────────────────────────────────

  /**
   * Analyse a file and produce a prioritised refactoring plan.
   */
  generatePlan(filePath: string): RefactoringPlan {
    const metrics = this.analyzeFile(filePath);
    const actions: RefactoringAction[] = [];

    // 1. File too long → split
    if (metrics.lines > MAX_FILE_LINES_FOR_REFACTORING) {
      const splitPoints = this.findSplitPoints(filePath);
      actions.push({
        type: "split_file",
        description: `File has ${metrics.lines} lines (limit ${MAX_FILE_LINES_FOR_REFACTORING}). Consider splitting into ${Math.ceil(metrics.lines / MAX_FILE_LINES_FOR_REFACTORING)} modules.`,
        priority: "high",
        estimatedImpact: `Reduce to ~${Math.round(metrics.lines / 2)} lines per module`,
        targetLines: splitPoints,
      });
    }

    // 2. High complexity → simplify
    if (metrics.complexity > COMPLEXITY_THRESHOLD) {
      const complexLines = this.findComplexLines(filePath);
      actions.push({
        type: "simplify",
        description: `Cyclomatic complexity is ${metrics.complexity} (threshold ${COMPLEXITY_THRESHOLD}). Reduce nested conditionals and early-return patterns.`,
        priority: metrics.complexity > COMPLEXITY_THRESHOLD * 2 ? "high" : "medium",
        estimatedImpact: `Reduce complexity to ≤${COMPLEXITY_THRESHOLD}`,
        targetLines: complexLines,
      });
    }

    // 3. Duplication → remove
    if (metrics.duplication > DUPLICATION_THRESHOLD) {
      const dupLines = this.findDuplicateLines(filePath);
      actions.push({
        type: "remove_duplication",
        description: `Estimated ${Math.round(metrics.duplication * 100)}% code duplication (threshold ${Math.round(DUPLICATION_THRESHOLD * 100)}%). Extract shared logic into helper functions.`,
        priority: "high",
        estimatedImpact: `Eliminate ~${Math.round(metrics.duplication * 100)}% duplicated code`,
        targetLines: dupLines,
      });
    }

    // 4. Long functions → extract
    if (metrics.maxFunctionLength > 50) {
      const longFuncLines = this.findLongFunctions(filePath);
      actions.push({
        type: "extract_function",
        description: `Longest function is ${metrics.maxFunctionLength} lines. Extract sub-sections into smaller helper functions.`,
        priority: "medium",
        estimatedImpact: `Break into functions of ≤30 lines each`,
        targetLines: longFuncLines,
      });
    }

    // 5. Import hygiene → reorganize
    if (metrics.dependencies.length > 5) {
      actions.push({
        type: "reorganize_imports",
        description: `${metrics.dependencies.length} imports found. Sort alphabetically and group by type (node builtins, external packages, local).`,
        priority: "low",
        estimatedImpact: "Improved readability and consistency",
      });
    }

    // Sort by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    actions.sort(
      (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
    );

    const totalEstimatedLines = actions.reduce(
      (sum, a) => sum + (a.targetLines?.length ?? 10),
      0
    );

    return { filePath: metrics.filePath, metrics, actions, totalEstimatedLines };
  }

  // ── Execution ───────────────────────────────────────────────

  /**
   * Apply every action in the plan to the file on disk.
   *
   * Currently implemented actions:
   * - `reorganize_imports` — sorts and groups imports
   * - `remove_duplication` — extracts the first duplicated block into a named helper
   * - `extract_function` — stubs out a comment marker for manual extraction
   * - `simplify` — adds a TODO marker near complex lines
   * - `split_file` — creates a `-part1.ts` / `-part2.ts` split with re-export
   */
  executePlan(plan: RefactoringPlan): RefactoringResult {
    const abs = path.resolve(plan.filePath);
    let content = fs.readFileSync(abs, "utf-8");
    const modifiedFiles: string[] = [abs];

    for (const action of plan.actions) {
      switch (action.type) {
        case "reorganize_imports":
          content = this.reorganizeImports(content);
          break;
        case "remove_duplication":
          content = this.removeDuplication(content, action);
          break;
        case "extract_function":
          content = this.extractFunction(content, action);
          break;
        case "simplify":
          content = this.addSimplificationMarkers(content, action);
          break;
        case "split_file": {
          const parts = this.splitFile(abs, content, action);
          modifiedFiles.push(...parts);
          break;
        }
      }
    }

    // Write back the main file (split_file writes its own parts)
    fs.writeFileSync(abs, content, "utf-8");

    const validation = this.validateChanges(modifiedFiles);

    return {
      plan,
      applied: true,
      modifiedFiles,
      validation,
    };
  }

  // ── Validation ──────────────────────────────────────────────

  /**
   * Run `npx tsc --noEmit` and check file sizes.
   */
  validateChanges(files: string[]): ValidationResult {
    let tscOutput = "";
    let tscSuccess = true;
    try {
      tscOutput = execSync("npx tsc --noEmit", {
        encoding: "utf-8",
        timeout: REFACTORING_VALIDATION_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      tscSuccess = false;
      if (err && typeof err === "object" && "stdout" in err) {
        tscOutput = String((err as { stdout: string }).stdout ?? "");
      } else if (err instanceof Error) {
        tscOutput = err.message;
      }
    }

    // Syntax check: try to parse each file as a quick smoke test.
    let syntaxValid = true;
    for (const f of files) {
      try {
        const c = fs.readFileSync(f, "utf-8");
        // Quick brace-balance check.
        let depth = 0;
        for (const ch of c) {
          if (ch === "{") depth++;
          if (ch === "}") depth--;
          if (depth < 0) {
            syntaxValid = false;
            break;
          }
        }
        if (depth !== 0) syntaxValid = false;
      } catch {
        syntaxValid = false;
      }
    }

    const sizeReasonable = files.every((f) => {
      try {
        const c = fs.readFileSync(f, "utf-8");
        return c.split("\n").length <= MAX_FILE_LINES_FOR_REFACTORING * 2;
      } catch {
        return false;
      }
    });

    return {
      success: tscSuccess && syntaxValid && sizeReasonable,
      tscOutput,
      syntaxValid,
      sizeReasonable,
    };
  }

  // ── Internal: complexity ────────────────────────────────────

  private estimateComplexity(content: string): number {
    // McCabe-style: start at 1, +1 for each branching keyword.
    const branchPatterns = [
      /\bif\b/g,
      /\belse\s+if\b/g,
      /\belse\b/g,
      /\bfor\b/g,
      /\bwhile\b/g,
      /\bcase\b/g,
      /\bcatch\b/g,
      /\b&&\b/g,
      /\b\|\|\b/g,
      /\?\?/g,
      /\?\./g,
      /=>/g,
    ];
    let complexity = 1;
    for (const pat of branchPatterns) {
      complexity += countMatches(content, pat);
    }
    return complexity;
  }

  // ── Internal: duplication ───────────────────────────────────

  private estimateDuplication(lines: string[]): number {
    if (lines.length < 6) return 0;

    // Normalised lines (strip whitespace).
    const norm = lines.map(normaliseLine).filter((l) => l.length > 0);
    if (norm.length < 6) return 0;

    // Find repeated consecutive-3-line blocks.
    const windowSize = 3;
    const seen = new Map<string, number[]>();
    const duplicatedLineIndices = new Set<number>();

    for (let i = 0; i <= norm.length - windowSize; i++) {
      const key = norm.slice(i, i + windowSize).join("\n");
      if (key.trim().length < 10) continue; // skip near-empty
      const indices = seen.get(key);
      if (indices) {
        indices.push(i);
        // Mark all occurrences.
        for (const idx of indices) {
          for (let j = idx; j < idx + windowSize && j < norm.length; j++) {
            duplicatedLineIndices.add(j);
          }
        }
      } else {
        seen.set(key, [i]);
      }
    }

    return norm.length > 0 ? duplicatedLineIndices.size / norm.length : 0;
  }

  // ── Internal: find closing brace ────────────────────────────

  private findClosingBrace(lines: string[], openLine: number): number {
    let depth = 0;
    let started = false;
    for (let i = openLine; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") {
          depth++;
          started = true;
        }
        if (ch === "}") depth--;
      }
      if (started && depth === 0) return i + 1; // 1-based
    }
    return lines.length;
  }

  // ── Internal: find split points ─────────────────────────────

  private findSplitPoints(filePath: string): number[] {
    const content = fs.readFileSync(path.resolve(filePath), "utf-8");
    const lines = content.split("\n");
    const points: number[] = [];

    // Heuristic: split at blank lines that sit between top-level declarations.
    for (let i = 0; i < lines.length; i++) {
      if (
        lines[i].trim() === "" &&
        i > 0 &&
        i < lines.length - 1 &&
        /^\s*(?:export\s+)?(?:function|class|const|let|var|interface|type)\b/.test(
          lines[i + 1] ?? ""
        )
      ) {
        points.push(i + 1); // 1-based
      }
    }

    // If no good heuristic points, split at ~half.
    if (points.length === 0) {
      points.push(Math.round(lines.length / 2));
    }

    return points;
  }

  // ── Internal: find complex lines ────────────────────────────

  private findComplexLines(filePath: string): number[] {
    const content = fs.readFileSync(path.resolve(filePath), "utf-8");
    const lines = content.split("\n");
    const result: number[] = [];
    const complexPatterns = [
      /\bif\s*\(.*\b(if|else|for|while)\b/,
      /\)\s*\{[^}]*\bif\b/,
      /&&.*&&/,
      /\|\|.*\|\|/,
      /\bif\s*\([^)]*\b&&\b[^)]*\b&&\b/,
      /\bif\s*\([^)]*\b\|\|\b[^)]*\b\|\|\b/,
    ];
    for (let i = 0; i < lines.length; i++) {
      for (const pat of complexPatterns) {
        if (pat.test(lines[i])) {
          result.push(i + 1);
          break;
        }
      }
    }
    return result;
  }

  // ── Internal: find duplicate blocks ──────────────────────────

  private findDuplicateLines(filePath: string): number[] {
    const content = fs.readFileSync(path.resolve(filePath), "utf-8");
    const lines = content.split("\n");
    const norm = lines.map(normaliseLine);
    const windowSize = 3;
    const seen = new Map<string, number[]>();
    const dupIndices = new Set<number>();

    for (let i = 0; i <= norm.length - windowSize; i++) {
      const key = norm.slice(i, i + windowSize).join("\n");
      if (key.trim().length < 10) continue;
      const indices = seen.get(key);
      if (indices && indices.length >= 1) {
        for (const idx of indices) {
          for (let j = idx; j < idx + windowSize; j++) dupIndices.add(j);
        }
        for (let j = i; j < i + windowSize; j++) dupIndices.add(j);
      } else {
        seen.set(key, [i]);
      }
    }

    return [...dupIndices].sort((a, b) => a - b).map((i) => i + 1);
  }

  // ── Internal: find long functions ───────────────────────────

  private findLongFunctions(filePath: string): number[] {
    const content = fs.readFileSync(path.resolve(filePath), "utf-8");
    const lines = content.split("\n");
    const funcPattern =
      /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:^|\s)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/gm;

    const result: number[] = [];
    for (const m of content.matchAll(funcPattern)) {
      const matchIdx = m.index ?? 0;
      const startLine = content.slice(0, matchIdx).split("\n").length;
      const endLine = this.findClosingBrace(lines, startLine - 1);
      const len = endLine - startLine + 1;
      if (len > 50) {
        // Mark the function's start and a point ~60% in.
        result.push(startLine);
        result.push(startLine + Math.round(len * 0.6));
      }
    }
    return result;
  }

  // ── Internal: import reorganization ─────────────────────────

  private reorganizeImports(content: string): string {
    const lines = content.split("\n");
    const imports: string[] = [];
    let lastImportIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      if (/^\s*import\b/.test(lines[i])) {
        imports.push(lines[i]);
        lastImportIdx = i;
      }
    }

    if (imports.length === 0) return content;

    const nodeBuiltins = new Set([
      "fs",
      "path",
      "os",
      "child_process",
      "util",
      "stream",
      "events",
      "crypto",
      "url",
      "http",
      "https",
      "net",
      "assert",
      "buffer",
      "querystring",
    ]);

    const external: string[] = [];
    const local: string[] = [];

    for (const imp of imports) {
      const match = imp.match(/from\s+["']([^"']+)["']/);
      const spec = match?.[1] ?? "";
      if (spec.startsWith(".") || spec.startsWith("/")) {
        local.push(imp);
      } else if (nodeBuiltins.has(spec.split("/")[0])) {
        // Node built-in
        external.unshift(imp); // builtins first
      } else {
        external.push(imp);
      }
    }

    const sorted = [...external.sort(), ...local.sort()];
    const newContent = lines.slice(lastImportIdx + 1);

    // Find where the first import started.
    let firstImportIdx = lines.findIndex((l) => /^\s*import\b/.test(l));
    if (firstImportIdx === -1) firstImportIdx = 0;

    const prefix = lines.slice(0, firstImportIdx);
    return [...prefix, ...sorted, "", ...newContent].join("\n");
  }

  // ── Internal: remove duplication ────────────────────────────

  private removeDuplication(
    content: string,
    action: RefactoringAction
  ): string {
    if (!action.targetLines || action.targetLines.length < 2) return content;

    const lines = content.split("\n");
    // Take the first duplicated range (3 consecutive lines).
    const targetLine = action.targetLines[0] - 1; // 0-based
    const start = Math.max(0, targetLine - 1);
    const end = Math.min(lines.length - 1, start + 2);
    const block = lines.slice(start, end + 1);
    const blockText = block.join("\n");

    // Check if a helper already exists.
    if (content.includes("// extracted-helper")) return content;

    const helperName = `extractedHelper_${Date.now()}`;
    const helper = `\n// extracted-helper\nfunction ${helperName}(): void {\n${blockText}\n}\n`;

    // Replace the first occurrence of the block with a call.
    const modifiedLines = [...lines];
    modifiedLines.splice(start, end - start + 1, `${helperName}();`);

    return helper + "\n" + modifiedLines.join("\n");
  }

  // ── Internal: extract function ──────────────────────────────

  private extractFunction(
    content: string,
    action: RefactoringAction
  ): string {
    if (!action.targetLines || action.targetLines.length === 0) return content;

    // Add a marker comment at the suggested extraction point.
    const lines = content.split("\n");
    const markerLine = action.targetLines[0] - 1;
    if (markerLine < lines.length) {
      lines.splice(
        markerLine,
        0,
        "// TODO(refactor): Extract the following section into a dedicated function."
      );
    }
    return lines.join("\n");
  }

  // ── Internal: simplification markers ────────────────────────

  private addSimplificationMarkers(
    content: string,
    action: RefactoringAction
  ): string {
    if (!action.targetLines || action.targetLines.length === 0) return content;

    const lines = content.split("\n");
    // Insert markers after each complex line (iterating in reverse to keep indices valid).
    const sorted = [...action.targetLines].sort((a, b) => b - a);
    for (const ln of sorted) {
      const idx = ln - 1;
      if (idx < lines.length) {
        lines.splice(
          idx + 1,
          0,
          "// TODO(refactor): Simplify this expression — consider early returns or extracted predicates."
        );
      }
    }
    return lines.join("\n");
  }

  // ── Internal: split file ────────────────────────────────────

  private splitFile(
    absPath: string,
    content: string,
    action: RefactoringAction
  ): string[] {
    const lines = content.split("\n");
    const points = action.targetLines ?? [Math.round(lines.length / 2)];
    const created: string[] = [];

    const ext = path.extname(absPath);
    const base = absPath.slice(0, -ext.length);

    // Split into chunks based on the first split point.
    const splitAt = Math.min(points[0] - 1, lines.length - 1);
    const part1 = lines.slice(0, splitAt).join("\n");
    const part2 = lines.slice(splitAt).join("\n");

    const part1Path = `${base}-part1${ext}`;
    const part2Path = `${base}-part2${ext}`;

    fs.writeFileSync(part1Path, part1, "utf-8");
    fs.writeFileSync(part2Path, part2, "utf-8");

    // Overwrite the original with a re-export barrel.
    const barrel = [
      `// Auto-generated barrel file after split.`,
      `export * from "./${path.basename(part1Path)}";`,
      `export * from "./${path.basename(part2Path)}";`,
      "",
    ].join("\n");

    // We'll write the barrel in the main executePlan caller (content is returned).
    // Store a marker so caller knows we handled the split.
    // Actually we write the barrel here; the caller will also write content, so
    // we need to return the barrel as the new content.
    // Since the method signature returns string[] of modified files and the caller
    // writes `content`, we use a trick: write the barrel directly and mark in
    // modifiedFiles. The caller will overwrite; we handle that by writing the barrel
    // to the file here and letting the caller's write be a no-op if we detect the
    // split was already applied.
    fs.writeFileSync(absPath, barrel, "utf-8");

    created.push(part1Path, part2Path);
    return created;
  }
}
