<div align="center">

# ⚡ klyxor

**AI coding agent CLI** with Plan/Build modes, subagent delegation, multi-provider LLM support, and a terminal UI.

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://typescriptlang.org)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

</div>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🎯 **Plan/Build Modes** | Read-only planning vs full-access execution |
| 🤖 **Subagent Delegation** | Spawn specialized agents for parallel tasks (max depth 2) |
| 🔀 **Multi-Provider LLM** | Multiple providers, each with multiple models — switch on the fly |
| 📋 **Tabbed Command Palette** | Sessions, Providers, Mode, Actions — all from one menu |
| 📝 **Markdown Chat** | Messages render with full Markdown support |
| 🧩 **Skills System** | Lazy-loaded `.md` skill files from `.klyxor/skills/` |
| 💾 **Session Persistence** | Sessions saved to `.klyxor/sessions.json` |
| ⏳ **Animated Spinner** | Visual loading indicator with tool name display |
| 🔄 **LLM Retry + Backoff** | Exponential backoff on transient failures (408/429/5xx) |
| 💰 **Token & Cost Tracking** | Per-model usage statistics and estimated costs |
| 📦 **Context Compaction** | Auto-summarizes old conversation turns when messages exceed threshold |
| 📂 **Project Context** | Auto-loads `AGENTS.md` / `KLYXOR.md` / `.klyxor/context.md` into system prompt |
| 🌐 **Web Fetch Tool** | Fetch URLs and extract readable text from HTML pages |
| 🔧 **Git Tools** | `git_status` and `git_diff` tools for version control context |
| 📝 **Session Export** | Export chat transcripts to Markdown files |
| 📋 **Todo List Tool** | Agent can create, update, delete, and track tasks during execution |
| 🔑 **Env-Var API Keys** | API keys support `${ENV_VAR}` expansion with `KLYXOR_API_KEY` fallback |

---

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build
```

On first launch, klyxor creates a `.klyxor/` directory with your config, sessions, and skills.

---

## ⚙️ Configuration

### Providers

Add providers via the command palette (`Ctrl+P` → **Providers** tab):

| Key | Action |
|-----|--------|
| `A` | Add new provider (name, base URL, model, API key) |
| `a` | Add model to existing provider |
| `Enter` | Select active model from provider's model list |
| `d` | Delete provider |

Or use slash commands:

```
/connect openai gpt-4o
/connect anthropic/claude-sonnet-4-20250514
```

### Models

Each provider supports **multiple models**. Switch between them from the command palette or via:

```
/connect provider/model
```

---

## 🎮 Keyboard Shortcuts

### Command Palette (`Ctrl+P`)

```
┌─────────────────────────────────────────────────────┐
│  Sessions │ Providers │ Mode │ Actions              │
├─────────────────────────────────────────────────────┤
│  h / ←    — switch tab left                         │
│  l / →    — switch tab right                        │
│  1-4      — jump to tab directly                    │
│  j / ↓    — navigate down                           │
│  k / ↑    — navigate up                             │
│  Enter    — select item / open model list           │
│  n        — new session    (Sessions tab)           │
│  a        — add model      (Providers tab)          │
│  A        — add provider   (Providers tab)          │
│  d        — delete item                             │
│  Esc      — close palette                           │
└─────────────────────────────────────────────────────┘
```

### Chat

| Key | Action |
|-----|--------|
| `Ctrl+P` | Open command palette |
| `Ctrl+C` | Exit |

---

## 📁 Project Structure

```
src/
├── cli.tsx              # Entry point
├── agent.ts             # Core agent loop (tool-calling)
├── llm.ts               # LLM HTTP client (OpenAI-compatible)
├── tools.ts             # Tool definitions (bash, read/write/edit, delegate, git, web, todo)
├── commands.ts          # Slash commands (/help, /plan, /build, /cost, /export, etc.)
├── config.ts            # Provider config, .klyxor/ init
├── constants.ts         # Centralized constants
├── sessions.ts          # Session persistence + todo list
├── skills.ts            # Skill system
├── usage.ts             # Token/cost tracking per model
├── compact.ts           # Context compaction (summarize old turns)
├── context.ts           # Project context auto-loader
├── export.ts            # Session export to Markdown
└── tui/
    ├── App.tsx              # Main app layout
    ├── CommandPalette.tsx   # Tabbed menu
    ├── Header.tsx           # Header with mode indicator
    ├── MarkdownText.tsx     # Markdown renderer
    ├── ProviderPicker.tsx   # Legacy provider picker
    ├── SessionPicker.tsx    # Session list
    └── Spinner.tsx          # Animated loading indicator
```

---

## 🎨 Constants

All magic numbers and hardcoded values are centralized in `src/constants.ts`:

| Category | Examples |
|----------|----------|
| ⏱️ Timeouts | Bash (120s), LLM fetch (120s), web fetch (20s) |
| 📊 Limits | Max turns (200), file read (2000 lines), grep results (200) |
| 🎨 UI | Brand color (`#51ff48`), separator widths, preview lengths |
| 🤖 LLM | Temperature (0.1), max tokens (4096), endpoint, retry (3 attempts) |
| 📦 Compaction | Threshold (60 messages), keep recent (20) |
| 📁 Skip | `.git`, `__pycache__`, `node_modules`, `.klyxor` |

---

## 💬 Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/plan` | Switch to Plan mode (read-only) |
| `/build` | Switch to Build mode (full access) |
| `/reset` | Clear session history |
| `/sessions [name]` | List sessions or switch to one |
| `/new [name]` | Create and switch to a new session |
| `/connect [name]` | Switch provider or list available |
| `/model [name]` | Show current model or switch |
| `/skills` | List available skills |
| `/skills create <name>` | Create a new skill |
| `/skills info <name>` | Show skill details |
| `/skills find <query>` | Find skills matching a file or task |
| `/cost` | Show token usage and estimated cost |
| `/tokens` | Alias for `/cost` |
| `/tools` | List available tools in current mode |
| `/export [path]` | Export session to Markdown file |
| `/compact` | Manually compress conversation history |
| `/exit`, `/quit` | Save and exit |

---

## 📄 License

[ISC](LICENSE)
