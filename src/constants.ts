/**
 * Centralized constants for Klyxor.
 *
 * Every magic number, default value, and configuration-like literal
 * that was previously scattered across the codebase lives here.
 * Import what you need — don't re-declare values.
 */

// ── Modes ──────────────────────────────────────────────────────
export const MODE_PLAN = "plan";
export const MODE_BUILD = "build";
export const DEFAULT_MODE = MODE_BUILD;

// ── Timeouts (ms) ──────────────────────────────────────────────
export const BASH_TIMEOUT_MS = 120_000;
export const LLM_TIMEOUT_MS = 120_000;

// ── LLM retry / backoff ────────────────────────────────────────
/** Number of attempts for a transient LLM failure (network/5xx/429). */
export const LLM_MAX_RETRIES = 3;
/** Base backoff delay (ms); grows exponentially per attempt. */
export const LLM_RETRY_BASE_MS = 800;
/** HTTP status codes that are safe to retry. */
export const LLM_RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// ── Limits ─────────────────────────────────────────────────────
export const DEFAULT_MAX_TURNS = 200;
export const DEFAULT_READ_FILE_LIMIT = 2000;
export const MAX_LIST_FILES_RESULTS = 200;
export const MAX_GREP_RESULTS = 200;
export const DEFAULT_MAX_TOKENS = 4096;
export const MAX_SUBAGENT_DEPTH = 2;

// ── Context compaction ─────────────────────────────────────────
/** When a session exceeds this many messages, auto-compact older turns. */
export const COMPACT_THRESHOLD_MESSAGES = 60;
/** How many of the most-recent messages to keep verbatim after compaction. */
export const COMPACT_KEEP_RECENT = 20;

// ── Web fetch ──────────────────────────────────────────────────
/** Max characters returned by the web_fetch tool. */
export const WEB_FETCH_MAX_CHARS = 8000;
/** Timeout for web_fetch requests (ms). */
export const WEB_FETCH_TIMEOUT_MS = 20_000;

// ── Project context files (auto-loaded into system prompt) ─────
export const PROJECT_CONTEXT_FILES = [
  "AGENTS.md",
  "KLYXOR.md",
  ".klyxor/context.md",
];

// ── Preview / truncation lengths ───────────────────────────────
export const PREVIEW = {
  /** Tool call args preview in agent log */
  args: 200,
  /** Tool result preview in agent log */
  result: 400,
  /** Delegate task preview in log */
  task: 100,
  /** Session list user message preview */
  session: 40,
  /** Skill description max length */
  skillDescription: 200,
  /** Tool output display in TUI */
  toolOutput: 200,
} as const;

// ── Separator / decoration widths ──────────────────────────────
export const SEPARATOR_WIDTH = 50;
export const BANNER_WIDTH = 60;
export const HEADING_UNDERLINE_WIDTH = 40;

// ── LLM defaults ───────────────────────────────────────────────
export const LLM_DEFAULTS = {
  toolChoice: "auto",
  temperature: 0.1,
  maxTokens: DEFAULT_MAX_TOKENS,
  endpoint: "/chat/completions",
} as const;

// ── Skip directories for grep ──────────────────────────────────
export const SKIP_DIRS = new Set([
  ".git",
  "__pycache__",
  "node_modules",
  ".klyxor",
]);

// ── Session ────────────────────────────────────────────────────
export const SESSION_NAME_PREFIX = "session-";

// ── Skills ─────────────────────────────────────────────────────
export const SKILL_FILE_EXTENSION = ".md";

// ── UI ─────────────────────────────────────────────────────────
export const BRAND_COLOR = "#51ff48";

/** Fixed UI elements height subtracted from terminal for palette viewport */
export const PALETTE_UI_HEIGHT = 8;
/** Minimum viewport height for the command palette */
export const MIN_VIEWPORT_HEIGHT = 5;
/** Palette header width */
export const PALETTE_HEADER_WIDTH = 38;

// ── UI text ────────────────────────────────────────────────────
export const WELCOME_MESSAGE =
  'Welcome to klyxor! Your AI coding assistant.\n\nTry: "explain this project" or "help me debug something"\nCommands: /help /plan /build /sessions';

export const LOADING_TEXT = "Analyzing your code...";

export const INPUT_PLACEHOLDER = "Ask me anything about your code...";

// ── Provider placeholders (for add-provider form) ──────────────
export const PROVIDER_PLACEHOLDERS = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-...",
  model: "gpt-4",
  name: "my-provider",
} as const;
