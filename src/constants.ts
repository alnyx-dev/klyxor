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

// ── Pipeline ──────────────────────────────────────────────────
/** Maximum number of steps allowed in a single pipeline execution. */
export const MAX_PIPELINE_STEPS = 20;
/** Timeout (ms) for each individual pipeline step command. */
export const PIPELINE_STEP_TIMEOUT_MS = 60_000;

// ── Limits ─────────────────────────────────────────────────────
export const DEFAULT_MAX_TURNS = 200;
export const DEFAULT_READ_FILE_LIMIT = 2000;
export const MAX_LIST_FILES_RESULTS = 200;
export const MAX_GREP_RESULTS = 200;
export const DEFAULT_MAX_TOKENS = 4096;
export const MAX_SUBAGENT_DEPTH = 2;
/** Max file size in bytes for read_file, edit_file, and hash tools (10 MB). */
export const MAX_FILE_READ_SIZE = 10 * 1024 * 1024;

// ── Subagent pool ──────────────────────────────────────────────
/** Maximum number of subagents that can run in parallel via spawn_parallel. */
export const MAX_PARALLEL_AGENTS = 5;
/** Timeout (ms) for the entire parallel pool to complete. */
export const SUBAGENT_POOL_TIMEOUT_MS = 300_000;

// ── Context compaction ─────────────────────────────────────────
/** When a session exceeds this many messages, auto-compact older turns. */
export const COMPACT_THRESHOLD_MESSAGES = 60;
/** How many of the most-recent messages to keep verbatim after compaction. */
export const COMPACT_KEEP_RECENT = 20;

// ── HTTP request ───────────────────────────────────────────────
/** Timeout for http_request tool (ms). */
export const HTTP_REQUEST_TIMEOUT_MS = 30_000;
/** Max characters returned by http_request tool. */
export const HTTP_MAX_RESPONSE_CHARS = 50_000;

// ── Tree ────────────────────────────────────────────────────────
/** Default depth for tree tool. */
export const DEFAULT_TREE_DEPTH = 3;
/** Max files returned by tree tool. */
export const MAX_TREE_FILES = 500;

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

// ── MCP ─────────────────────────────────────────────────────────
/** Timeout for MCP server connection (ms). */
export const MCP_CONNECT_TIMEOUT_MS = 30_000;
/** Timeout for MCP tool calls (ms). */
export const MCP_TOOL_CALL_TIMEOUT_MS = 60_000;
/** Maximum tools allowed per MCP server. */
export const MCP_MAX_TOOLS_PER_SERVER = 100;

// ── Streaming ────────────────────────────────────────────────
/** Enable streaming by default for real-time token display. */
export const DEFAULT_STREAM_ENABLED = true;

// ── Error Recovery ───────────────────────────────────────────
/** Maximum retries for transient errors. */
export const ERROR_RECOVERY_MAX_RETRIES = 3;
/** Base delay (ms) for error recovery backoff. */
export const ERROR_RECOVERY_BASE_DELAY_MS = 1000;
/** Maximum delay (ms) for error recovery backoff. */
export const ERROR_RECOVERY_MAX_DELAY_MS = 30_000;
/** Model to use as fallback when primary fails. */
export const ERROR_RECOVERY_FALLBACK_MODEL = "gpt-4o-mini";

// ── Git worktree ────────────────────────────────────────────────
/** Default directory for git worktrees, relative to the project root. */
export const GIT_WORKTREE_BASE_DIR = ".klyxor/worktrees";

// ── Provider placeholders (for add-provider form) ──────────────
export const PROVIDER_PLACEHOLDERS = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-...",
  model: "gpt-4",
  name: "my-provider",
} as const;

// ── Custom Tools ──────────────────────────────────────────────
/** Directory (relative to cwd) where user-defined tool JSON files live. */
export const CUSTOM_TOOLS_DIR = ".klyxor/tools";
/** Maximum number of custom tools to load. */
export const MAX_CUSTOM_TOOLS = 50;

// ── Time Machine (snapshots) ──────────────────────────────────
/** Maximum number of snapshots to retain. Oldest are pruned first. */
export const MAX_SNAPSHOTS = 100;
/** Directory (relative to cwd) where snapshot JSON files are stored. */
export const SNAPSHOTS_DIR = ".klyxor/snapshots";
/** Maximum number of files a single snapshot may contain. */
export const MAX_SNAPSHOT_FILES = 50;

// ── Refactoring Engine ────────────────────────────────────────
/** Files exceeding this line count are flagged for splitting. */
export const MAX_FILE_LINES_FOR_REFACTORING = 500;
/** Duplication percentage above which the engine flags removal. */
export const DUPLICATION_THRESHOLD = 0.2;
/** Cyclomatic complexity above which the engine suggests simplification. */
export const COMPLEXITY_THRESHOLD = 10;
/** Timeout (ms) for TypeScript compilation validation after refactoring. */
export const REFACTORING_VALIDATION_TIMEOUT_MS = 30_000;

// ── Predictive Bug Detection ────────────────────────────────
/** Maximum nesting depth before flagging. */
export const MAX_NESTING_DEPTH = 5;
/** Maximum function length (lines) before flagging. */
export const MAX_FUNCTION_LENGTH = 50;
/** Maximum return statements per function before flagging. */
export const MAX_RETURN_STATEMENTS = 10;
/** Maximum number of files to scan in a single directory scan. */
export const BUG_SCAN_MAX_FILES = 100;

// ── Multi-agent orchestration ────────────────────────────────
/** Maximum number of specialized agents that can run concurrently. */
export const MAX_CONCURRENT_AGENTS = 5;
/** Timeout (ms) for a single agent role execution within an orchestration. */
export const AGENT_TASK_TIMEOUT_MS = 120_000;
