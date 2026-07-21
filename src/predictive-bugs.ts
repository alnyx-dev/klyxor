/**
 * PredictiveBugDetector — static analysis for common code bugs.
 *
 * Uses regex-based pattern matching (no AST parser) to scan TypeScript /
 * JavaScript source files and flag likely bugs, code smells, and risky
 * patterns before they cause runtime failures.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  MAX_NESTING_DEPTH,
  MAX_FUNCTION_LENGTH,
  MAX_RETURN_STATEMENTS,
  BUG_SCAN_MAX_FILES,
  SKIP_DIRS,
} from "./constants.js";

// ── Interfaces ────────────────────────────────────────────────

export interface BugPattern {
  id: string;
  name: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  pattern: RegExp;
  language: string; // "typescript" | "javascript" | "any"
  suggestion: string;
  category: string;
}

export interface BugReport {
  file: string;
  line: number;
  column: number;
  pattern: BugPattern;
  code: string;
  suggestion: string;
}

export interface SeveritySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

// ── Built-in Patterns ─────────────────────────────────────────

const BUILTIN_PATTERNS: BugPattern[] = [
  // ── Null Safety ──
  {
    id: "json-parse-no-try",
    name: "JSON.parse without try-catch",
    description: "JSON.parse can throw on malformed input",
    severity: "high",
    pattern: /(?<!.*try\s*\{[\s\S]{0,200})JSON\.parse\(/g,
    language: "any",
    suggestion: "Wrap JSON.parse in a try-catch block",
    category: "null-safety",
  },
  {
    id: "promise-no-catch",
    name: "Promise chain without .catch()",
    description: "Unhandled promise rejections can crash the process",
    severity: "critical",
    pattern: /\.then\([^)]*\)(?!\s*\.catch\()((?!\s*\.))/g,
    language: "any",
    suggestion: "Add .catch() handler to the promise chain",
    category: "async",
  },
  {
    id: "array-access-no-check",
    name: "Array index access without length check",
    description: "Accessing array[0] without checking length can return undefined",
    severity: "medium",
    pattern: /(\w+)\[0\](?!\s*(?:\?\?|&&|if|\]))/g,
    language: "any",
    suggestion: "Check array length before accessing by index",
    category: "null-safety",
  },
  {
    id: "optional-chain-assignment",
    name: "Optional chain on left-hand side",
    description: "Optional chaining (?.) should not be used in assignments",
    severity: "high",
    pattern: /\?\.\s*\w+\s*=/g,
    language: "any",
    suggestion: "Use a null check before assignment instead of optional chaining",
    category: "null-safety",
  },

  // ── Async Issues ──
  {
    id: "async-no-await",
    name: "Async function missing await",
    description: "Function is async but never uses await",
    severity: "medium",
    pattern: /async\s+(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>))\s*(?:\([^)]*\)|[^{])*\{(?![\s\S]*\bawait\b[\s\S]*\})/g,
    language: "any",
    suggestion: "Consider removing async keyword if no await is used, or add missing await",
    category: "async",
  },
  {
    id: "unhandled-promise-all",
    name: "Promise.all without error handling",
    description: "Promise.all rejects on first failure — handle errors",
    severity: "high",
    pattern: /Promise\.all\((?![\s\S]*\.catch\()/g,
    language: "any",
    suggestion: "Add .catch() or wrap in try-catch to handle rejections",
    category: "async",
  },
  {
    id: "missing-await-assignment",
    name: "Missing await for async function call",
    description: "Calling an async function without await returns a Promise, not the result",
    severity: "high",
    pattern: /(?:const|let|var)\s+\w+\s*=\s*\w+\([^)]*\)\s*;/g,
    language: "any",
    suggestion: "Add 'await' before async function calls",
    category: "async",
  },

  // ── Resource Leaks ──
  {
    id: "set-interval-no-clear",
    name: "setInterval without clearInterval",
    description: "setInterval keeps running — clear it on cleanup",
    severity: "medium",
    pattern: /setInterval\(/g,
    language: "any",
    suggestion: "Store the interval ID and call clearInterval() on cleanup",
    category: "resource",
  },
  {
    id: "event-listener-no-remove",
    name: "addEventListener without removeEventListener",
    description: "Event listeners leak if not removed on cleanup",
    severity: "medium",
    pattern: /addEventListener\(/g,
    language: "any",
    suggestion: "Call removeEventListener() in cleanup/destroy function",
    category: "resource",
  },

  // ── Logic Bugs ──
  {
    id: "equality-coercion",
    name: "Loose equality (== or !=)",
    description: "Loose equality can cause unexpected type coercion",
    severity: "medium",
    pattern: /[^!=!]==(?!=)/g,
    language: "any",
    suggestion: "Use strict equality (=== or !==) instead",
    category: "logic",
  },
  {
    id: "assignment-in-condition",
    name: "Assignment in condition",
    description: "Assigning value in a condition is almost always a bug",
    severity: "critical",
    pattern: /(?:if|while|for)\s*\([^)]*[^=!<>]==?[^=][^)]*\)/g,
    language: "any",
    suggestion: "Move assignment outside the condition",
    category: "logic",
  },
  {
    id: "unreachable-return",
    name: "Unreachable code after return",
    description: "Code after a return statement is never executed",
    severity: "high",
    pattern: /return\s+[^;]+;\s*\n\s*[^\s\}\/]/g,
    language: "any",
    suggestion: "Remove unreachable code or fix control flow",
    category: "logic",
  },
  {
    id: "empty-catch",
    name: "Empty catch block",
    description: "Swallowing errors silently hides bugs",
    severity: "high",
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/g,
    language: "any",
    suggestion: "At minimum, log the error or re-throw it",
    category: "logic",
  },
  {
    id: "double-negation",
    name: "Double negation (!!value)",
    description: "Double negation is often unnecessary and hurts readability",
    severity: "low",
    pattern: /!!\w+/g,
    language: "any",
    suggestion: "Use Boolean(value) or just the value directly if already boolean",
    category: "logic",
  },

  // ── Type Safety ──
  {
    id: "as-any",
    name: "Type assertion 'as any'",
    description: "'as any' bypasses TypeScript type checking",
    severity: "high",
    pattern: /\bas\s+any\b/g,
    language: "typescript",
    suggestion: "Use a specific type or 'unknown' instead of 'any'",
    category: "type",
  },
  {
    id: "ts-ignore",
    name: "@ts-ignore or @ts-expect-error",
    description: "Suppressing TypeScript errors hides type issues",
    severity: "high",
    pattern: /@(?:ts-ignore|ts-expect-error)/g,
    language: "typescript",
    suggestion: "Fix the underlying type error instead of suppressing it",
    category: "type",
  },
  {
    id: "non-null-assertion",
    name: "Non-null assertion (!)",
    description: "Non-null assertion can cause runtime errors if value is null",
    severity: "medium",
    pattern: /\w+!\./g,
    language: "typescript",
    suggestion: "Use optional chaining or a null check instead",
    category: "type",
  },

  // ── Security ──
  {
    id: "eval-usage",
    name: "eval() usage",
    description: "eval() is a security risk and performance anti-pattern",
    severity: "critical",
    pattern: /\beval\s*\(/g,
    language: "any",
    suggestion: "Avoid eval() — use JSON.parse() or a safe alternative",
    category: "security",
  },
  {
    id: "inner-html",
    name: "innerHTML assignment",
    description: "innerHTML can lead to XSS vulnerabilities",
    severity: "high",
    pattern: /\.innerHTML\s*=/g,
    language: "any",
    suggestion: "Use textContent or a sanitization library instead",
    category: "security",
  },
  {
    id: "hardcoded-secret",
    name: "Hardcoded secret or password",
    description: "Hardcoded secrets are a security vulnerability",
    severity: "critical",
    pattern: /(?:password|secret|api_?key|token|auth)\s*[:=]\s*["'][^"']+["']/gi,
    language: "any",
    suggestion: "Move secrets to environment variables",
    category: "security",
  },

  // ── Code Quality ──
  {
    id: "console-log",
    name: "console.log in production code",
    description: "console.log should not be left in production code",
    severity: "low",
    pattern: /console\.log\(/g,
    language: "any",
    suggestion: "Remove console.log or use a proper logging library",
    category: "quality",
  },
  {
    id: "magic-number",
    name: "Magic number",
    description: "Hardcoded numeric literals should be named constants",
    severity: "low",
    pattern: /(?<![.\w])(?:[2-9]\d{2,}|[1-9]\d{3,})(?![.\w\d])/g,
    language: "any",
    suggestion: "Extract magic numbers into named constants",
    category: "quality",
  },
  {
    id: "var-usage",
    name: "var declaration",
    description: "var has function scope — use const or let instead",
    severity: "medium",
    pattern: /\bvar\s+/g,
    language: "any",
    suggestion: "Use 'const' or 'let' instead of 'var'",
    category: "quality",
  },
];

// ── Class ─────────────────────────────────────────────────────

export class PredictiveBugDetector {
  private patterns: BugPattern[];
  private customPatterns: BugPattern[] = [];

  constructor(additionalPatterns?: BugPattern[]) {
    this.patterns = [...BUILTIN_PATTERNS, ...(additionalPatterns ?? [])];
  }

  /** Get all patterns (built-in + custom). */
  getPatterns(): BugPattern[] {
    return [...this.patterns, ...this.customPatterns];
  }

  /** Add a custom pattern at runtime. */
  addCustomPattern(pattern: BugPattern): void {
    if (!pattern.id || !pattern.pattern) {
      throw new Error("Pattern must have an id and a RegExp pattern");
    }
    this.customPatterns.push(pattern);
  }

  /** Scan a single file and return all bug reports. */
  scanFile(filePath: string): BugReport[] {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return [];
    }

    const lines = content.split("\n");
    const reports: BugReport[] = [];
    const allPatterns = [...this.patterns, ...this.customPatterns];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const lineNum = lineIdx + 1;

      for (const pattern of allPatterns) {
        // Reset regex state
        pattern.pattern.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = pattern.pattern.exec(line)) !== null) {
          reports.push({
            file: filePath,
            line: lineNum,
            column: match.index + 1,
            pattern,
            code: line.trim(),
            suggestion: pattern.suggestion,
          });
        }
      }

      // Nesting depth check
      const nestingLevel = this._countNesting(line);
      if (nestingLevel > MAX_NESTING_DEPTH) {
        reports.push({
          file: filePath,
          line: lineNum,
          column: 1,
          pattern: {
            id: "deep-nesting",
            name: "Deep nesting",
            description: `Nesting depth (${nestingLevel}) exceeds ${MAX_NESTING_DEPTH}`,
            severity: "medium",
            pattern: /^\s*$/,
            language: "any",
            suggestion: "Extract nested logic into separate functions",
            category: "quality",
          },
          code: line.trim(),
          suggestion: "Extract nested logic into separate functions",
        });
      }
    }

    // Function length check
    this._checkFunctionLength(lines, filePath, reports);

    // Return statement count check
    this._checkReturnCount(lines, filePath, reports);

    return reports;
  }

  /** Scan a directory recursively. */
  scanDirectory(dirPath: string): BugReport[] {
    const reports: BugReport[] = [];
    let fileCount = 0;

    const scan = (dir: string) => {
      if (fileCount >= BUG_SCAN_MAX_FILES) return;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (fileCount >= BUG_SCAN_MAX_FILES) return;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            scan(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if ([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"].includes(ext)) {
            reports.push(...this.scanFile(fullPath));
            fileCount++;
          }
        }
      }
    };

    scan(dirPath);
    return reports;
  }

  /** Get a severity summary of a set of reports. */
  getSeveritySummary(reports: BugReport[]): SeveritySummary {
    const summary: SeveritySummary = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const report of reports) {
      summary[report.pattern.severity]++;
    }
    return summary;
  }

  // ── Private helpers ───────────────────────────────────────

  private _countNesting(line: string): number {
    let depth = 0;
    for (const ch of line) {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
    }
    return depth;
  }

  private _checkFunctionLength(
    lines: string[],
    filePath: string,
    reports: BugReport[]
  ): void {
    let inFunction = false;
    let braceDepth = 0;
    let funcStart = -1;
    let funcName = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (!inFunction) {
        const match = line.match(
          /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>))/
        );
        if (match) {
          inFunction = true;
          funcStart = i;
          funcName = match[1] ?? match[2] ?? "anonymous";
          braceDepth = 0;
        }
      }

      if (inFunction) {
        for (const ch of line) {
          if (ch === "{") braceDepth++;
          if (ch === "}") braceDepth--;
        }

        if (braceDepth <= 0 && i > funcStart) {
          const length = i - funcStart + 1;
          if (length > MAX_FUNCTION_LENGTH) {
            reports.push({
              file: filePath,
              line: funcStart + 1,
              column: 1,
              pattern: {
                id: "long-function",
                name: "Long function",
                description: `Function '${funcName}' is ${length} lines (max: ${MAX_FUNCTION_LENGTH})`,
                severity: "medium",
                pattern: /^\s*$/,
                language: "any",
                suggestion: "Break this function into smaller, focused functions",
                category: "quality",
              },
              code: `function ${funcName}(...)`,
              suggestion: "Break this function into smaller, focused functions",
            });
          }
          inFunction = false;
        }
      }
    }
  }

  private _checkReturnCount(
    lines: string[],
    filePath: string,
    reports: BugReport[]
  ): void {
    let inFunction = false;
    let braceDepth = 0;
    let funcStart = -1;
    let funcName = "";
    let returnCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (!inFunction) {
        const match = line.match(
          /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>))/
        );
        if (match) {
          inFunction = true;
          funcStart = i;
          funcName = match[1] ?? match[2] ?? "anonymous";
          braceDepth = 0;
          returnCount = 0;
        }
      }

      if (inFunction) {
        if (/\breturn\b/.test(line)) returnCount++;

        for (const ch of line) {
          if (ch === "{") braceDepth++;
          if (ch === "}") braceDepth--;
        }

        if (braceDepth <= 0 && i > funcStart) {
          if (returnCount > MAX_RETURN_STATEMENTS) {
            reports.push({
              file: filePath,
              line: funcStart + 1,
              column: 1,
              pattern: {
                id: "too-many-returns",
                name: "Too many return statements",
                description: `Function '${funcName}' has ${returnCount} return statements (max: ${MAX_RETURN_STATEMENTS})`,
                severity: "medium",
                pattern: /^\s*$/,
                language: "any",
                suggestion: "Simplify function logic or extract helper functions",
                category: "quality",
              },
              code: `function ${funcName}(...)`,
              suggestion: "Simplify function logic or extract helper functions",
            });
          }
          inFunction = false;
        }
      }
    }
  }
}
