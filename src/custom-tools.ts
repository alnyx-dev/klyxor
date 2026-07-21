/**
 * Custom Tool Loader
 *
 * Loads user-defined tools from JSON configuration files in `.klyxor/tools/`.
 * Each JSON file defines a tool with a shell command that executes when called.
 *
 * Tool JSON format:
 * ```json
 * {
 *   "name": "my_tool",
 *   "description": "Does something useful",
 *   "parameters": {
 *     "type": "object",
 *     "properties": {
 *       "input": { "type": "string", "description": "Input text" }
 *     },
 *     "required": ["input"]
 *   },
 *   "command": "echo '{input}'",
 *   "timeout": 30000
 * }
 * ```
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createTool } from "./tools.js";
import type { Tool, ToolParameters, ToolParameterProperty } from "./tools.js";
import {
  CUSTOM_TOOLS_DIR,
  MAX_CUSTOM_TOOLS,
  BASH_TIMEOUT_MS,
} from "./constants.js";

/**
 * Definition of a custom tool loaded from a JSON configuration file.
 */
export interface CustomToolDef {
  /** Unique tool name (alphanumeric + underscores only). */
  name: string;
  /** Human-readable description of what the tool does. */
  description: string;
  /** JSON Schema parameters for the tool's arguments. */
  parameters: ToolParameters;
  /** Shell command to execute. Use `{paramName}` for argument interpolation. */
  command: string;
  /** Timeout in milliseconds (default: BASH_TIMEOUT_MS). */
  timeout?: number;
}

/** Valid tool name pattern: lowercase alphanumeric and underscores only. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Validates that a tool name is safe and follows conventions.
 * Names must start with a lowercase letter and contain only lowercase letters,
 * digits, and underscores.
 */
function validateToolName(name: string): string | null {
  if (!name || typeof name !== "string") {
    return "Tool name is required";
  }
  if (!TOOL_NAME_PATTERN.test(name)) {
    return `Invalid tool name '${name}': must match ${TOOL_NAME_PATTERN}`;
  }
  if (name.length > 64) {
    return `Tool name '${name}' exceeds 64 characters`;
  }
  return null; // valid
}

/**
 * Validates a CustomToolDef object has all required fields with correct types.
 */
function validateToolDef(def: Record<string, unknown>): string | null {
  if (typeof def.name !== "string") {
    return "Missing or invalid 'name' field";
  }
  if (typeof def.description !== "string") {
    return "Missing or invalid 'description' field";
  }
  if (typeof def.command !== "string") {
    return "Missing or invalid 'command' field";
  }
  if (!def.command.trim()) {
    return "Command cannot be empty";
  }
  const params = def.parameters as Record<string, unknown> | undefined;
  if (params) {
    if (params.type !== "object") {
      return "parameters.type must be 'object'";
    }
    if (params.properties && typeof params.properties !== "object") {
      return "parameters.properties must be an object";
    }
    if (params.required && !Array.isArray(params.required)) {
      return "parameters.required must be an array";
    }
  }
  return null; // valid
}

/**
 * Escapes a string for safe use in a shell command (single-quote wrapping).
 * Replaces ' with '\'' (end quote, escaped quote, start quote).
 */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Interpolates `{paramName}` placeholders in a command string with actual values.
 * Arguments are shell-escaped to prevent injection.
 */
function interpolateCommand(
  command: string,
  args: Record<string, unknown>
): string {
  return command.replace(/\{(\w+)\}/g, (match, paramName) => {
    if (!(paramName in args)) {
      // Leave missing args as empty string (not an error — optional params)
      return "";
    }
    const val = args[paramName];
    return shellEscape(String(val ?? ""));
  });
}

/**
 * Loads and manages custom tools from JSON configuration files.
 *
 * Scans `.klyxor/tools/` for `*.json` files, parses each as a tool definition,
 * validates them, and converts them into executable `Tool` instances.
 *
 * @example
 * ```ts
 * const loader = new CustomToolLoader();
 * const tools = loader.loadTools();
 * for (const tool of tools) {
 *   console.log(tool.name, tool.description);
 * }
 * ```
 */
export class CustomToolLoader {
  private toolsDir: string;

  /**
   * Create a CustomToolLoader.
   * @param toolsDir - Directory to scan for tool JSON files (default: CUSTOM_TOOLS_DIR relative to cwd)
   */
  constructor(toolsDir?: string) {
    this.toolsDir = toolsDir ?? path.resolve(CUSTOM_TOOLS_DIR);
  }

  /**
   * Load all valid custom tools from the tools directory.
   *
   * Scans for `*.json` files, parses each, validates the definition,
   * and converts to executable `Tool` instances using `createTool()`.
   *
   * @returns Array of Tool instances ready for use.
   */
  loadTools(): Tool[] {
    if (!fs.existsSync(this.toolsDir)) {
      return [];
    }

    const files = fs.readdirSync(this.toolsDir).filter((f) => {
      if (!f.endsWith(".json")) return false;
      const fullPath = path.join(this.toolsDir, f);
      return fs.statSync(fullPath).isFile();
    });

    const tools: Tool[] = [];

    for (const file of files) {
      if (tools.length >= MAX_CUSTOM_TOOLS) {
        break;
      }

      const fullPath = path.join(this.toolsDir, file);
      try {
        const raw = fs.readFileSync(fullPath, "utf-8");
        const def = JSON.parse(raw) as Record<string, unknown>;
        const tool = this.parseAndCreateTool(def, file);
        if (tool) {
          tools.push(tool);
        }
      } catch (e) {
        // Skip files that can't be read or parsed
        console.error(`⚠️  Skipping custom tool file '${file}': ${e}`);
      }
    }

    return tools;
  }

  /**
   * Parse a raw JSON object into a Tool instance.
   * Returns null if validation fails (with error logged).
   */
  private parseAndCreateTool(
    def: Record<string, unknown>,
    sourceFile: string
  ): Tool | null {
    // Validate structure
    const validationError = validateToolDef(def);
    if (validationError) {
      console.error(
        `⚠️  Invalid custom tool in '${sourceFile}': ${validationError}`
      );
      return null;
    }

    // Validate name
    const nameError = validateToolName(def.name as string);
    if (nameError) {
      console.error(
        `⚠️  Invalid custom tool in '${sourceFile}': ${nameError}`
      );
      return null;
    }

    const name = def.name as string;
    const description = def.description as string;
    const command = def.command as string;
    const timeout =
      typeof def.timeout === "number" ? def.timeout : BASH_TIMEOUT_MS;

    // Build parameters with defaults
    const params = (def.parameters ?? { type: "object", properties: {} }) as {
      type: "object";
      properties?: Record<string, unknown>;
      required?: string[];
    };

    const parameters: ToolParameters = {
      type: "object",
      properties: {},
      required: Array.isArray(params.required) ? params.required : undefined,
    };

    // Convert parameter properties to ToolParameterProperty format
    if (params.properties) {
      for (const [key, value] of Object.entries(params.properties)) {
        const prop = value as Record<string, unknown>;
        const toolProp: ToolParameterProperty = {
          type: (prop.type as string) ?? "string",
        };
        if (typeof prop.description === "string") {
          toolProp.description = prop.description;
        }
        if (Array.isArray(prop.enum)) {
          toolProp.enum = prop.enum.map(String);
        }
        parameters.properties[key] = toolProp;
      }
    }

    // Create tool using the project's createTool factory
    return createTool(name, description, parameters, (...args) => {
      // Build kwargs from parameter names and positional args
      const paramNames = Object.keys(parameters.properties);
      const kwargs: Record<string, unknown> = {};
      for (let i = 0; i < paramNames.length; i++) {
        kwargs[paramNames[i]] = args[i];
      }

      // Interpolate arguments into command
      const finalCommand = interpolateCommand(command, kwargs);

      // Execute the shell command
      try {
        const result = execSync(finalCommand, {
          timeout,
          encoding: "utf-8",
          maxBuffer: 1024 * 1024, // 1MB buffer
          cwd: process.cwd(),
        });
        return result || "(empty output)";
      } catch (e) {
        const err = e as { stderr?: string; message?: string };
        return `Command failed: ${err.stderr || err.message || String(e)}`;
      }
    });
  }
}
