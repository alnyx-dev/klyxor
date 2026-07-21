import * as fs from "node:fs";
import * as path from "node:path";
import { SKILLS_DIR } from "./config.js";
import { createTool, type Tool } from "./tools.js";
import { SKILL_FILE_EXTENSION, PREVIEW } from "./constants.js";

// ── Types ───────────────────────────────────────────────────────

export interface SkillMetadata {
  /** Display name (defaults to filename without extension) */
  name?: string;
  /** One-line description */
  description?: string;
  /** File extensions or keywords that auto-trigger this skill */
  triggers?: string[];
  /** Categorization tags */
  tags?: string[];
  /** Semantic version */
  version?: string;
  /** Names of skills this one depends on */
  requires?: string[];
}

export interface SkillInfo {
  /** Absolute path to the .md file */
  path: string;
  /** One-line description (from frontmatter or first non-heading line) */
  description: string;
  /** Parsed frontmatter metadata */
  metadata: SkillMetadata;
  /** Raw markdown content (without frontmatter) */
  content: string;
}

// ── YAML Frontmatter Parser ─────────────────────────────────────
// Minimal YAML parser for frontmatter — handles arrays, strings, booleans.
// No external dependencies.

function parseFrontmatter(raw: string): { metadata: SkillMetadata; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { metadata: {}, body: raw };
  }

  const yamlBlock = match[1];
  const body = match[2].trim();
  const parsed: Record<string, unknown> = {};

  let currentKey = "";
  let isArray = false;

  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Array item (indented under a key)
    if (isArray && (line.startsWith("  - ") || line.startsWith("\t- "))) {
      const value = trimmed.replace(/^-\s*/, "").trim().replace(/^["']|["']$/g, "");
      const arr = parsed[currentKey];
      if (Array.isArray(arr)) {
        arr.push(value);
      }
      continue;
    }

    // New key: value
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    currentKey = key;
    isArray = false;

    if (!value || value === "[]") {
      // Empty array or empty value
      if (value === "[]") {
        parsed[key] = [];
        isArray = true;
      }
      continue;
    }

    // Parse value
    if (value.startsWith("[") && value.endsWith("]")) {
      // Inline array: [a, b, c]
      const items = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      parsed[key] = items;
    } else if (value === "true") {
      parsed[key] = true;
    } else if (value === "false") {
      parsed[key] = false;
    } else {
      parsed[key] = value.replace(/^["']|["']$/g, "");
      isArray = false;
    }
  }

  const metadata: SkillMetadata = {
    name: typeof parsed.name === "string" ? parsed.name : undefined,
    description: typeof parsed.description === "string" ? parsed.description : undefined,
    triggers: Array.isArray(parsed.triggers) ? parsed.triggers.map(String) : undefined,
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : undefined,
    version: typeof parsed.version === "string" ? parsed.version : undefined,
    requires: Array.isArray(parsed.requires) ? parsed.requires.map(String) : undefined,
  };

  return { metadata, body };
}

// ── Skill Discovery ─────────────────────────────────────────────

/**
 * Discover all .md files in .klyxor/skills/ and return name → info map.
 * Supports both YAML frontmatter and legacy plain markdown.
 */
export function discoverSkills(): Record<string, SkillInfo> {
  const skills: Record<string, SkillInfo> = {};
  if (!fs.existsSync(SKILLS_DIR)) return skills;

  let entries: string[];
  try {
    entries = fs.readdirSync(SKILLS_DIR).sort();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Warning: failed to read skills directory: ${msg}`);
    return skills;
  }

  for (const fname of entries) {
    if (!fname.endsWith(SKILL_FILE_EXTENSION)) continue;
    const skillPath = path.join(SKILLS_DIR, fname);
    try {
      const raw = fs.readFileSync(skillPath, "utf-8");
      const { metadata, body } = parseFrontmatter(raw);

      // Description: frontmatter > first non-heading line > empty
      let description = metadata.description || "";
      if (!description) {
        const lines = body
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        const startIdx = lines.length > 0 && lines[0].startsWith("#") ? 1 : 0;
        for (let i = startIdx; i < lines.length; i++) {
          if (!lines[i].startsWith("#")) {
            description = lines[i];
            break;
          }
        }
      }

      const skillName = metadata.name || fname.slice(0, -3);
      skills[skillName] = {
        path: skillPath,
        description: description.slice(0, PREVIEW.skillDescription),
        metadata,
        content: body,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Warning: failed to read skill ${fname}: ${msg}`);
      // skip unreadable files
    }
  }
  return skills;
}

// ── Auto-Trigger System ─────────────────────────────────────────

/**
 * Find skills that match the given context (file path + task text).
 * Returns skill names sorted by relevance (most matches first).
 */
export function findMatchingSkills(
  filePath?: string,
  taskText?: string
): string[] {
  const skills = discoverSkills();
  const matches: { name: string; score: number }[] = [];

  for (const [name, info] of Object.entries(skills)) {
    const triggers = info.metadata.triggers || [];
    if (triggers.length === 0) continue;

    let score = 0;

    for (const trigger of triggers) {
      // File extension match: "*.py" matches "foo.py"
      if (trigger.startsWith("*.")) {
        const ext = trigger.slice(1); // ".py"
        if (filePath && filePath.endsWith(ext)) {
          score += 10;
        }
      }
      // Keyword match in task text
      if (taskText && taskText.toLowerCase().includes(trigger.toLowerCase())) {
        score += 5;
      }
      // Keyword match in file path
      if (filePath && filePath.toLowerCase().includes(trigger.toLowerCase())) {
        score += 3;
      }
    }

    if (score > 0) {
      matches.push({ name, score });
    }
  }

  return matches
    .sort((a, b) => b.score - a.score)
    .map((m) => m.name);
}

/**
 * Resolve all dependencies for a skill (recursive, depth-limited).
 * Returns ordered list of skill names to load (dependencies first).
 */
export function resolveDependencies(
  skillName: string,
  loaded: Set<string> = new Set(),
  depth: number = 0
): string[] {
  if (depth > 5) return []; // prevent infinite loops
  if (loaded.has(skillName)) return [];

  const skills = discoverSkills();
  const skill = skills[skillName];
  if (!skill) return [];

  const result: string[] = [];
  const requires = skill.metadata.requires || [];

  for (const dep of requires) {
    if (!loaded.has(dep)) {
      loaded.add(dep);
      result.push(...resolveDependencies(dep, loaded, depth + 1));
      result.push(dep);
    }
  }

  return result;
}

/**
 * Load a skill and all its dependencies.
 * Returns array of { name, content } in dependency order.
 */
export function loadSkillWithDeps(
  skillName: string
): { name: string; content: string }[] {
  const skills = discoverSkills();
  const toLoad = [skillName, ...resolveDependencies(skillName)];
  const result: { name: string; content: string }[] = [];

  for (const name of toLoad) {
    const skill = skills[name];
    if (skill) {
      result.push({ name, content: skill.content });
    }
  }

  return result;
}

// ── Skill CRUD ──────────────────────────────────────────────────

/**
 * Create a new skill file with YAML frontmatter.
 */
export function createSkill(
  name: string,
  options: {
    description?: string;
    triggers?: string[];
    tags?: string[];
    requires?: string[];
  } = {}
): string {
  if (name.length > 64) return "Error: Skill name too long (max 64 chars)";
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return "Error: Skill name must contain only letters, numbers, underscores, and hyphens";
  }

  const skillPath = path.join(SKILLS_DIR, `${name}${SKILL_FILE_EXTENSION}`);

  if (fs.existsSync(skillPath)) {
    return `Error: skill '${name}' already exists.`;
  }

  // Build frontmatter
  const lines = ["---"];
  lines.push(`name: ${name}`);
  if (options.description) {
    lines.push(`description: "${options.description}"`);
  }
  if (options.triggers && options.triggers.length > 0) {
    lines.push("triggers:");
    for (const t of options.triggers) {
      lines.push(`  - ${t}`);
    }
  }
  if (options.tags && options.tags.length > 0) {
    lines.push("tags:");
    for (const t of options.tags) {
      lines.push(`  - ${t}`);
    }
  }
  if (options.requires && options.requires.length > 0) {
    lines.push("requires:");
    for (const r of options.requires) {
      lines.push(`  - ${r}`);
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(`# ${name}`);
  lines.push("");
  lines.push("## Rules");
  lines.push("");
  lines.push("<!-- Add your instructions here -->");
  lines.push("");

  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  fs.writeFileSync(skillPath, lines.join("\n"), "utf-8");
  return `Created skill '${name}' at ${skillPath}`;
}

/**
 * Get detailed info about a skill.
 */
export function getSkillInfo(name: string): string {
  const skills = discoverSkills();
  const skill = skills[name];
  if (!skill) {
    return `Error: unknown skill '${name}'.`;
  }

  const meta = skill.metadata;
  const lines = [
    `Skill: ${name}`,
    `Path: ${skill.path}`,
    `Description: ${skill.description || "(none)"}`,
  ];

  if (meta.version) lines.push(`Version: ${meta.version}`);
  if (meta.tags && meta.tags.length > 0) lines.push(`Tags: ${meta.tags.join(", ")}`);
  if (meta.triggers && meta.triggers.length > 0) lines.push(`Triggers: ${meta.triggers.join(", ")}`);
  if (meta.requires && meta.requires.length > 0) lines.push(`Requires: ${meta.requires.join(", ")}`);

  return lines.join("\n");
}

// ── Tool Builders ───────────────────────────────────────────────

export function makeListSkillsTool(): Tool {
  function handler(): string {
    const skills = discoverSkills();
    const names = Object.keys(skills);
    if (names.length === 0) return "No skills available.";
    return names
      .map((n) => {
        const s = skills[n];
        const tags = s.metadata.tags ? ` [${s.metadata.tags.join(", ")}]` : "";
        return `- ${n}: ${s.description}${tags}`;
      })
      .join("\n");
  }

  return createTool(
    "list_skills",
    "List available skills (name + description + tags). Call this early when a task " +
      "might match a known workflow (e.g. specific file format, framework, deployment process).",
    { type: "object", properties: {} },
    handler
  );
}

export function makeReadSkillTool(): Tool {
  function handler(name: string): string {
    const loaded = loadSkillWithDeps(name);
    if (loaded.length === 0) {
      return `Error: unknown skill '${name}'. Call list_skills to see what's available.`;
    }

    const parts: string[] = [];
    for (const { name: skillName, content } of loaded) {
      if (skillName !== name) {
        parts.push(`--- Dependency: ${skillName} ---\n${content}`);
      } else {
        parts.push(content);
      }
    }

    return parts.join("\n\n");
  }

  return createTool(
    "read_skill",
    "Load the full instructions for a skill by name (use after list_skills identifies a relevant one). " +
      "Dependencies are loaded automatically.",
    {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
    handler
  );
}

export function makeFindSkillsTool(): Tool {
  function handler(args: { file_path?: string; task?: string }): string {
    const matches = findMatchingSkills(args.file_path, args.task);
    if (matches.length === 0) return "No matching skills found.";

    const skills = discoverSkills();
    return matches
      .map((n) => `- ${n}: ${skills[n]?.description || ""}`)
      .join("\n");
  }

  return createTool(
    "find_skills",
    "Find skills matching a file path or task description. Use to auto-discover relevant skills.",
    {
      type: "object",
      properties: {
        file_path: { type: "string", description: "File path to match against triggers" },
        task: { type: "string", description: "Task description to match against triggers" },
      },
    },
    handler
  );
}
