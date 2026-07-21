/**
 * Multi-agent orchestration system for klyxor.
 *
 * Provides a registry of specialized agent roles, keyword-based role
 * suggestion, and parallel orchestration via `Promise.allSettled()`.
 * Pure logic — no LLM calls.
 */

import { MAX_CONCURRENT_AGENTS, AGENT_TASK_TIMEOUT_MS } from "./constants.js";

// ── Types ─────────────────────────────────────────────────────

export type AgentRole =
  | "frontend"
  | "backend"
  | "database"
  | "devops"
  | "security"
  | "testing"
  | "documentation";

export interface SpecializedAgent {
  role: AgentRole;
  description: string;
  expertise: string[];
  tools: string[];
  constraints: string[];
}

export interface OrchestrationTask {
  task: string;
  requiredRoles: AgentRole[];
  parallelizable: boolean;
}

export interface OrchestrationResult {
  task: string;
  roleResults: {
    role: AgentRole;
    result: string;
    filesChanged: string[];
    duration: number;
  }[];
  mergedResult: string;
  totalDuration: number;
  success: boolean;
}

/** Internal wrapper for Promise.allSettled result handling. */
interface RoleExecution {
  role: AgentRole;
  result: string;
  filesChanged: string[];
  duration: number;
}

// ── Keyword → role mapping ────────────────────────────────────

const ROLE_KEYWORDS: Record<AgentRole, string[]> = {
  frontend: ["react", "css", "ui", "component", "html", "accessibility", "jsx", "tsx", "styling", "layout"],
  backend: ["api", "endpoint", "auth", "logic", "server", "middleware", "route", "business"],
  database: ["database", "schema", "migration", "query", "sql", "index", "orm", "model", "table"],
  devops: ["docker", "deploy", "ci", "cd", "pipeline", "infra", "kubernetes", "container", "build", "release"],
  security: ["security", "vulnerability", "xss", "injection", "csrf", "encryption", "auth", "permission", "sanitize"],
  testing: ["test", "spec", "mock", "assert", "coverage", "e2e", "unit", "integration", "fixture"],
  documentation: ["readme", "docs", "documentation", "changelog", "comment", "javadoc", "jsdoc", "api doc"],
};

// ── Pre-configured agents ─────────────────────────────────────

const AGENT_REGISTRY: SpecializedAgent[] = [
  {
    role: "frontend",
    description: "UI/UX development with React, CSS, and HTML",
    expertise: ["React", "CSS", "HTML", "UI/UX", "accessibility", "responsive design", "component architecture"],
    tools: ["read_file", "write_file", "edit_file", "list_files", "bash"],
    constraints: [
      "Do not modify database schemas or API endpoints",
      "Do not change deployment configuration",
      "Prioritize accessibility (WCAG 2.1 AA)",
    ],
  },
  {
    role: "backend",
    description: "API development, business logic, and server-side processing",
    expertise: ["API design", "business logic", "data processing", "authentication", "middleware", "error handling"],
    tools: ["read_file", "write_file", "edit_file", "list_files", "grep", "bash"],
    constraints: [
      "Do not modify frontend components or styles",
      "Do not change deployment configuration",
      "Ensure all inputs are validated",
    ],
  },
  {
    role: "database",
    description: "Schema design, migrations, queries, and performance optimization",
    expertise: ["schema design", "migrations", "query optimization", "indexing", "ORM configuration", "data modeling"],
    tools: ["read_file", "write_file", "edit_file", "list_files", "bash"],
    constraints: [
      "Do not modify application logic",
      "Always provide rollback migrations",
      "Never drop tables without explicit confirmation",
    ],
  },
  {
    role: "devops",
    description: "Docker, CI/CD pipelines, deployment, and infrastructure",
    expertise: ["Docker", "CI/CD", "deployment", "infrastructure", "monitoring", "logging", "containerization"],
    tools: ["read_file", "write_file", "edit_file", "list_files", "bash"],
    constraints: [
      "Do not modify application source code",
      "Ensure secrets are not hardcoded",
      "Maintain backward compatibility with existing deployments",
    ],
  },
  {
    role: "security",
    description: "Vulnerability assessment, authentication, and security hardening",
    expertise: ["vulnerability assessment", "authentication", "authorization", "encryption", "XSS prevention", "CSRF protection"],
    tools: ["read_file", "grep", "list_files", "bash"],
    constraints: [
      "Do not disable existing security measures",
      "Report findings without making breaking changes",
      "Follow principle of least privilege",
    ],
  },
  {
    role: "testing",
    description: "Unit tests, integration tests, e2e tests, and mocking strategies",
    expertise: ["unit testing", "integration testing", "e2e testing", "mocking", "test coverage", "test fixtures"],
    tools: ["read_file", "write_file", "edit_file", "list_files", "bash"],
    constraints: [
      "Do not modify production code (only test files)",
      "Ensure tests are deterministic (no flaky tests)",
      "Use existing test framework and patterns",
    ],
  },
  {
    role: "documentation",
    description: "README, API docs, inline comments, and changelogs",
    expertise: ["README", "API documentation", "inline comments", "changelogs", "architecture docs", "tutorials"],
    tools: ["read_file", "write_file", "edit_file", "list_files"],
    constraints: [
      "Do not modify code logic",
      "Follow existing documentation style",
      "Include code examples where appropriate",
    ],
  },
];

// ── Orchestrator ──────────────────────────────────────────────

export class MultiAgentOrchestrator {
  private readonly agents: Map<AgentRole, SpecializedAgent>;

  constructor() {
    this.agents = new Map();
    for (const agent of AGENT_REGISTRY) {
      this.agents.set(agent.role, agent);
    }
  }

  /**
   * Retrieve a specialized agent by role.
   */
  getAgent(role: AgentRole): SpecializedAgent {
    const agent = this.agents.get(role);
    if (!agent) {
      throw new Error(`Unknown agent role: ${role}`);
    }
    return agent;
  }

  /**
   * Return all registered specialized agents.
   */
  getAllAgents(): SpecializedAgent[] {
    return [...this.agents.values()];
  }

  /**
   * Analyze a task description and suggest which roles are needed
   * based on keyword matching.
   *
   * Returns a deduplicated list of roles, ordered by relevance
   * (number of keyword matches descending).
   */
  suggestRoles(task: string): AgentRole[] {
    const lower = task.toLowerCase();
    const scores: [AgentRole, number][] = [];

    for (const [role, keywords] of Object.entries(ROLE_KEYWORDS) as [AgentRole, string[]][]) {
      let hits = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) {
          hits++;
        }
      }
      if (hits > 0) {
        scores.push([role, hits]);
      }
    }

    // Sort by match count descending, return roles only
    scores.sort((a, b) => b[1] - a[1]);
    return scores.map(([role]) => role);
  }

  /**
   * Orchestrate a task across multiple specialized agent roles.
   *
   * - If `parallelizable` is true, all roles execute concurrently
   *   (bounded by MAX_CONCURRENT_AGENTS via chunking).
   * - If false, roles execute sequentially.
   * - Failures are graceful: one role failing does not abort others.
   * - Each role execution is wrapped in a timeout.
   */
  async orchestrate(
    task: string,
    roles: AgentRole[],
    options?: { parallelizable?: boolean },
  ): Promise<OrchestrationResult> {
    const parallelizable = options?.parallelizable ?? true;
    const startTime = Date.now();
    const roleResults: OrchestrationResult["roleResults"] = [];

    if (roles.length === 0) {
      return {
        task,
        roleResults: [],
        mergedResult: "No roles specified — nothing to orchestrate.",
        totalDuration: 0,
        success: true,
      };
    }

    // Validate all roles exist
    for (const role of roles) {
      this.getAgent(role);
    }

    if (parallelizable && roles.length > 1) {
      // Chunk roles to respect MAX_CONCURRENT_AGENTS
      const chunks = this.chunkArray(roles, MAX_CONCURRENT_AGENTS);

      for (const chunk of chunks) {
        const settled = await Promise.allSettled(
          chunk.map((role) => this.executeRole(role, task)),
        );

        for (let i = 0; i < settled.length; i++) {
          const outcome = settled[i]!;
          const role = chunk[i]!;

          if (outcome.status === "fulfilled") {
            roleResults.push(outcome.value);
          } else {
            roleResults.push({
              role,
              result: `Agent failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
              filesChanged: [],
              duration: 0,
            });
          }
        }
      }
    } else {
      // Sequential execution
      for (const role of roles) {
        try {
          const result = await this.executeRole(role, task);
          roleResults.push(result);
        } catch (err) {
          roleResults.push({
            role,
            result: `Agent failed: ${err instanceof Error ? err.message : String(err)}`,
            filesChanged: [],
            duration: 0,
          });
        }
      }
    }

    const totalDuration = Date.now() - startTime;
    const allSucceeded = roleResults.every((r) => !r.result.startsWith("Agent failed"));

    return {
      task,
      roleResults,
      mergedResult: this.mergeResults(roleResults),
      totalDuration,
      success: allSucceeded,
    };
  }

  // ── Private helpers ────────────────────────────────────────

  /**
   * Simulate executing a single role's portion of the task.
   *
   * In a real integration this would spawn an LLM-backed agent
   * with the role's system prompt, tools, and constraints. Here
   * we produce a structured placeholder result.
   */
  private async executeRole(
    role: AgentRole,
    task: string,
  ): Promise<RoleExecution> {
    const agent = this.getAgent(role);
    const start = Date.now();

    // Simulate async work with a timeout guard
    return new Promise<RoleExecution>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Role "${role}" timed out after ${AGENT_TASK_TIMEOUT_MS}ms`));
      }, AGENT_TASK_TIMEOUT_MS);

      // Yield to microtask queue to simulate async processing
      queueMicrotask(() => {
        clearTimeout(timer);

        const result = [
          `[${role}] Processed task: "${task}"`,
          `Expertise applied: ${agent.expertise.join(", ")}`,
          `Tools available: ${agent.tools.join(", ")}`,
          `Constraints: ${agent.constraints.length} active`,
        ].join("\n");

        resolve({
          role,
          result,
          filesChanged: [],
          duration: Date.now() - start,
        });
      });
    });
  }

  /**
   * Merge all role results into a single summary string.
   */
  private mergeResults(results: RoleExecution[]): string {
    if (results.length === 0) {
      return "No results to merge.";
    }

    const lines: string[] = [
      `Orchestration complete — ${results.length} role(s) executed.`,
      "",
    ];

    for (const r of results) {
      const status = r.result.startsWith("Agent failed") ? "✗" : "✓";
      lines.push(`${status} ${r.role} (${r.duration}ms) — ${r.filesChanged.length} file(s) changed`);
    }

    const failures = results.filter((r) => r.result.startsWith("Agent failed"));
    if (failures.length > 0) {
      lines.push("", `${failures.length} role(s) failed — partial result.`);
    }

    return lines.join("\n");
  }

  /**
   * Split an array into chunks of a given size.
   */
  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
