import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { MAX_SUBAGENT_DEPTH } from "./constants.js";

export { MAX_SUBAGENT_DEPTH };

export const APP_NAME = "Klyxor";

/** Global config directory at ~/.klyxor (user's home, not cwd). */
export const KLYXOR_DIR = path.join(os.homedir(), ".klyxor");
export const SKILLS_DIR = path.join(KLYXOR_DIR, "skills");
export const CONFIG_FILE = path.join(KLYXOR_DIR, "config.json");
export const SESSIONS_FILE = path.join(KLYXOR_DIR, "sessions.json");

export const DEFAULT_SKILL_FILENAME = "python-tests.md";
export const DEFAULT_SKILL_CONTENT = `\
# python-tests

Run and interpret Python test suites (pytest), and write new tests that follow repo conventions.

## When to use this
- The task involves writing, fixing, or running tests in a Python repo.
- A bug report needs a reproducing test before a fix.

## How to proceed
1. Look for a test runner config first: \`pytest.ini\`, \`pyproject.toml\` (\`[tool.pytest.ini_options]\`),
   or \`setup.cfg\`. Use whatever command/markers the repo already defines instead of guessing.
2. Run the existing suite once before changing anything, so you have a baseline
   (\`pytest -q\` is a reasonable default if nothing repo-specific is found).
3. For a bug fix: write a minimal failing test that reproduces the bug first, confirm it fails,
   then fix the code, then confirm the test passes.
4. New tests should live next to existing tests for the module being changed (mirror the
   existing directory structure — don't invent a new layout).
5. Don't weaken assertions or add \`# type: ignore\` / broad \`except:\` just to make a test pass —
   if a test can't pass honestly, say so instead of papering over it.
6. Report which tests were added/changed and the final pass/fail counts in your summary.
`;

/**
 * Ensure the .klyxor directory and skills subdirectory exist.
 * Seeds an example skill on first run.
 * Returns true if this was a fresh init.
 */
export function ensureKlyxorDir(): boolean {
  const fresh = !fs.existsSync(KLYXOR_DIR);
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  if (fresh) {
    const examplePath = path.join(SKILLS_DIR, DEFAULT_SKILL_FILENAME);
    if (!fs.existsSync(examplePath)) {
      fs.writeFileSync(examplePath, DEFAULT_SKILL_CONTENT, "utf-8");
    }
  }
  return fresh;
}

export interface Provider {
  base_url: string;
  api_key: string;
  /** @deprecated Use active_model instead. Kept for backward compat. */
  model: string;
  /** All available models for this provider */
  models: string[];
  /** Currently selected model */
  active_model: string;
}

export interface ConfigData {
  providers: Record<string, Provider>;
  active_provider: string;
}

let _providers: Record<string, Provider> = {
  default: {
    base_url: "http://ip:port/v1",
    api_key: "...",
    model: "...",
    models: ["..."],
    active_model: "...",
  },
};
let _activeProvider = "default";

export function getProviders(): Record<string, Provider> {
  return _providers;
}

export function getActiveProviderName(): string {
  return _activeProvider;
}

export function setActiveProviderName(name: string): void {
  _activeProvider = name;
}

/**
 * Resolve an api_key value, expanding environment-variable references.
 * Supports three forms:
 *   - "${MY_ENV_VAR}"  → value of process.env.MY_ENV_VAR
 *   - "env:MY_ENV_VAR" → value of process.env.MY_ENV_VAR
 *   - a literal key string → returned as-is
 * Falls back to KLYXOR_API_KEY if the stored value is empty/placeholder.
 */
export function resolveApiKey(raw: string | undefined): string {
  const placeholder = !raw || raw === "..." || raw.trim() === "";
  if (!placeholder) {
    const braceMatch = raw.match(/^\$\{([A-Z0-9_]+)\}$/i);
    if (braceMatch) return process.env[braceMatch[1]] || "";
    if (raw.startsWith("env:")) return process.env[raw.slice(4)] || "";
    return raw;
  }
  return process.env.KLYXOR_API_KEY || "";
}

export function getActiveProvider(): Provider {
  const p = _providers[_activeProvider];
  if (!p) return p;
  // Return a shallow clone with the api_key resolved from env when applicable,
  // so callers (llm.ts) always get a usable key without mutating stored config.
  return { ...p, api_key: resolveApiKey(p.api_key) };
}

/** The provider record exactly as stored (unresolved api_key). For config editing. */
export function getRawActiveProvider(): Provider {
  return _providers[_activeProvider];
}

export function listProvidersText(): string {
  const lines: string[] = [];
  for (const [name, p] of Object.entries(_providers)) {
    const marker = name === _activeProvider ? "*" : " ";
    const model = getActiveModel(p);
    const modelList = p.models?.length > 0 ? p.models.join(", ") : model;
    lines.push(`${marker} ${name}: model=${model} models=[${modelList}] base_url=${p.base_url}`);
  }
  return lines.join("\n");
}

export function addProvider(
  name: string,
  base_url: string,
  model: string,
  api_key: string
): string {
  if (!name) return "cancelled";
  if (!base_url || !model) return "cancelled: base_url and model are required";
  const models = [model];
  _providers[name] = { base_url, api_key, model, models, active_model: model };
  _activeProvider = name;
  return `→ added and switched to provider '${name}'`;
}

export function getActiveModel(provider?: Provider): string {
  const p = provider || _providers[_activeProvider];
  if (!p) return "";
  return p.active_model || p.model || p.models?.[0] || "";
}

export function setActiveModel(providerName: string, model: string): string {
  const p = _providers[providerName];
  if (!p) return `Unknown provider '${providerName}'`;
  // Auto-add model to list if not present
  if (!p.models) p.models = [];
  if (!p.models.includes(model)) {
    p.models.push(model);
  }
  p.active_model = model;
  p.model = model; // keep deprecated field in sync
  return `→ switched ${providerName} to model '${model}'`;
}

export function addModelToProvider(providerName: string, model: string): string {
  const p = _providers[providerName];
  if (!p) return `Unknown provider '${providerName}'`;
  if (!model) return "Model name is required";
  if (!p.models) p.models = [];
  if (p.models.includes(model)) return `Model '${model}' already exists`;
  p.models.push(model);
  // If this is the first model, make it active
  if (p.models.length === 1) {
    p.active_model = model;
    p.model = model;
  }
  return `→ added model '${model}' to ${providerName}`;
}

export function removeModelFromProvider(providerName: string, model: string): string {
  const p = _providers[providerName];
  if (!p) return `Unknown provider '${providerName}'`;
  if (!p.models || !p.models.includes(model)) {
    return `Model '${model}' not found in ${providerName}`;
  }
  if (p.models.length <= 1) {
    return `Cannot remove the only model from ${providerName}`;
  }
  p.models = p.models.filter((m) => m !== model);
  // If removed model was active, switch to first remaining
  if (p.active_model === model || p.model === model) {
    const newModel = p.models[0];
    p.active_model = newModel;
    p.model = newModel;
    return `→ removed '${model}', switched to '${newModel}'`;
  }
  return `→ removed model '${model}' from ${providerName}`;
}

export function connectCommand(arg: string): string {
  arg = arg.trim();
  if (arg) {
    // Support "provider/model" syntax
    const slashIdx = arg.indexOf("/");
    if (slashIdx !== -1) {
      const providerName = arg.slice(0, slashIdx);
      const modelName = arg.slice(slashIdx + 1);
      if (!(providerName in _providers)) {
        return `Unknown provider '${providerName}'. Known: ${Object.keys(_providers).join(", ")}.`;
      }
      _activeProvider = providerName;
      const result = setActiveModel(providerName, modelName);
      saveConfig();
      return `→ switched to provider '${providerName}'\n  ${result}`;
    }
    if (!(arg in _providers)) {
      return `Unknown provider '${arg}'. Known: ${Object.keys(_providers).join(", ")}. Run /connect with no name to add a new one.`;
    }
    _activeProvider = arg;
    return `→ switched to provider '${arg}'`;
  }
  // No arg: list providers (interactive add handled by TUI/REPL)
  return listProvidersText();
}

export function removeProvider(name: string): string {
  if (!(name in _providers)) {
    return `Unknown provider '${name}'`;
  }
  const names = Object.keys(_providers);
  if (names.length === 1) {
    return "Cannot remove the only provider";
  }
  delete _providers[name];
  if (_activeProvider === name) {
    const remaining = Object.keys(_providers);
    _activeProvider = remaining[0];
    return `Removed '${name}', switched to '${_activeProvider}'`;
  }
  return `Removed provider '${name}'`;
}

export function saveConfig(): void {
  try {
    const data: ConfigData = {
      providers: _providers,
      active_provider: _activeProvider,
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error(`⚠️  Could not save config to ${CONFIG_FILE}: ${e}`);
  }
}

export function loadConfig(): boolean {
  if (!fs.existsSync(CONFIG_FILE)) return false;
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const data = JSON.parse(raw) as {
      providers?: Record<string, Partial<Provider> & { model?: string }>;
      active_provider?: string;
    };
    const providers = data.providers;
    if (providers && Object.keys(providers).length > 0) {
      // Migrate old configs: add models/active_model if missing
      for (const [, p] of Object.entries(providers)) {
        if (!p.models) {
          p.models = p.model ? [p.model] : [];
        }
        if (!p.active_model) {
          p.active_model = p.model || p.models[0] || "";
        }
      }
      _providers = providers as Record<string, Provider>;
    }
    _activeProvider = data.active_provider || _activeProvider;
    if (!(_activeProvider in _providers)) {
      _activeProvider = Object.keys(_providers)[0] || "default";
    }
    return true;
  } catch (e) {
    console.error(
      `⚠️  Could not load ${CONFIG_FILE} (${e}), using default provider config.`
    );
    return false;
  }
}

export function saveState(): void {
  saveConfig();
}
