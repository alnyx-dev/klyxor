import * as fs from "node:fs";
import * as path from "node:path";
import { SKILLS_DIR } from "./config.js";
import { createTool, type Tool } from "./tools.js";
import { SKILL_FILE_EXTENSION, PREVIEW } from "./constants.js";

export interface SkillInfo {
  path: string;
  description: string;
}

/**
 * Discover all .md files in .klyxor/skills/ and return name → info map.
 */
export function discoverSkills(): Record<string, SkillInfo> {
  const skills: Record<string, SkillInfo> = {};
  if (!fs.existsSync(SKILLS_DIR)) return skills;

  let entries: string[];
  try {
    entries = fs.readdirSync(SKILLS_DIR).sort();
  } catch {
    return skills;
  }

  for (const fname of entries) {
    if (!fname.endsWith(SKILL_FILE_EXTENSION)) continue;
    const skillPath = path.join(SKILLS_DIR, fname);
    try {
      const text = fs.readFileSync(skillPath, "utf-8");
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      // First non-empty line is usually a "# title" heading; the description
      // is the next non-empty, non-heading line after it.
      let description = "";
      const startIdx = lines.length > 0 && lines[0].startsWith("#") ? 1 : 0;
      for (let i = startIdx; i < lines.length; i++) {
        if (!lines[i].startsWith("#")) {
          description = lines[i];
          break;
        }
      }

      skills[fname.slice(0, -3)] = {
        path: skillPath,
        description: description.slice(0, PREVIEW.skillDescription),
      };
    } catch {
      // skip unreadable files
    }
  }
  return skills;
}

export function makeListSkillsTool(): Tool {
  function handler(): string {
    const skills = discoverSkills();
    const names = Object.keys(skills);
    if (names.length === 0) return "No skills available.";
    return names
      .map((n) => `- ${n}: ${skills[n].description}`)
      .join("\n");
  }

  return createTool(
    "list_skills",
    "List available skills (name + one-line description). Call this early when a task " +
      "might match a known workflow (e.g. specific file format, framework, deployment process).",
    { type: "object", properties: {} },
    handler
  );
}

export function makeReadSkillTool(): Tool {
  function handler(name: string): string {
    const skills = discoverSkills();
    if (!(name in skills)) {
      return `Error: unknown skill '${name}'. Call list_skills to see what's available.`;
    }
    try {
      return fs.readFileSync(skills[name].path, "utf-8");
    } catch (e) {
      return `Error reading skill '${name}': ${e}`;
    }
  }

  return createTool(
    "read_skill",
    "Load the full instructions for a skill by name (use after list_skills identifies a relevant one).",
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
