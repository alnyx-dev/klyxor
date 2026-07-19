import * as fs from "node:fs";
import * as path from "node:path";

export const APP_NAME = "Klyxor";

export const DEFAULT_MAX_TURNS = 200;
export const MAX_SUBAGENT_DEPTH = 2;

export const KLYXOR_DIR = path.join(process.cwd(), ".klyxor");
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
  model: string;
}

export interface ConfigData {
  providers: Record<string, Provider>;
  active_provider: string;
}

let _providers: Record<string, Provider> = {
  default: { base_url: "http://ip:port/v1", api_key: "...", model: "..." },
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

export function getActiveProvider(): Provider {
  return _providers[_activeProvider];
}

export function listProvidersText(): string {
  const lines: string[] = [];
  for (const [name, p] of Object.entries(_providers)) {
    const marker = name === _activeProvider ? "*" : " ";
    lines.push(`${marker} ${name}: model=${p.model} base_url=${p.base_url}`);
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
  _providers[name] = { base_url, api_key, model };
  _activeProvider = name;
  return `→ added and switched to provider '${name}'`;
}

export function connectCommand(arg: string): string {
  arg = arg.trim();
  if (arg) {
    if (!(arg in _providers)) {
      return `Unknown provider '${arg}'. Known: ${Object.keys(_providers).join(", ")}. Run /connect with no name to add a new one.`;
    }
    _activeProvider = arg;
    return `→ switched to provider '${arg}'`;
  }
  // No arg: list providers (interactive add handled by TUI/REPL)
  return listProvidersText();
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
    const data: ConfigData = JSON.parse(raw);
    const providers = data.providers;
    if (providers && Object.keys(providers).length > 0) {
      _providers = providers;
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
