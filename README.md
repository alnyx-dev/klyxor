<div align="center">

# ⚡ klyxor

**AI coding agent CLI** with Plan/Build modes, subagent delegation, multi-provider LLM support, streaming, MCP integration, and a terminal UI.

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://typescriptlang.org)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

</div>

---

## ✨ Features

### Core

| Feature | Description |
|---------|-------------|
| 🎯 **Plan/Build Modes** | Read-only planning vs full-access execution |
| ⚡ **Streaming Responses** | Real-time token streaming from LLM — see responses as they arrive |
| 🛡️ **Error Recovery** | Smart retry with exponential backoff, rate-limit handling, fallback model support |
| 🔄 **Parallel Subagents** | Spawn multiple agents in parallel for concurrent task execution |
| 🤖 **Subagent Delegation** | Spawn specialized agents for complex tasks (max depth 2) |
| 🔀 **Multi-Provider LLM** | Multiple providers, each with multiple models — switch on the fly |
| 📦 **Update Checker** | Auto-checks npm registry for updates on startup |

### Tools

| Tool | Description |
|------|-------------|
| 📝 **read_file / write_file / edit_file** | Full file operations with line-precision editing |
| 🔍 **grep** | Regex search across project files |
| 📁 **list_files / tree** | Directory listing and tree visualization |
| 🌐 **web_fetch** | Fetch URLs and extract readable text |
| 🔧 **git_status / git_diff** | Version control context |
| 📋 **todo_list** | Task tracking during execution |
| 🔑 **env_read** | Read environment variables |
| 📊 **file_info** | File metadata (size, dates, permissions) |
| 🔀 **copy_file / move_file** | File operations (destructive — blocked in plan mode) |
| 📄 **diff_apply** | Apply unified diff patches |
| 🔗 **http_request** | HTTP requests (GET/POST/PUT/DELETE) with headers/body |
| 📦 **json_query** | Read JSON files with dot-notation navigation |
| 🔐 **hash** | File/string hashing (md5/sha1/sha256) |
| 📋 **base64** | Base64 encode/decode |
| 🌳 **git_worktree** | Manage git worktrees for parallel development |
| 🛠️ **custom_tools** | User-defined tools via JSON config |
| 🔗 **pipeline** | Chain commands with template interpolation |
| 🔄 **spawn_parallel** | Parallel subagent execution |
| 🤖 **delegate** | Single subagent delegation |

### Intelligence

| Feature | Description |
|---------|-------------|
| 🔍 **Refactoring Engine** | Analyze code, generate refactoring plans, execute with validation |
| 🤖 **Multi-Agent Orchestrator** | Specialized agents (frontend, backend, database, devops, security, testing, docs) |
| ⏰ **Time Machine** | Create snapshots, restore, compare, branch your codebase |
| 🐛 **Predictive Bug Detector** | Pattern-based bug prediction across 25+ categories |

### MCP Integration

| Feature | Description |
|---------|-------------|
| 🔌 **MCP Support** | Connect to Model Context Protocol servers |
| 🧩 **MCP Tool Bridging** | Bridge MCP tools as agent tools (`mcp_<server>_<tool>`) |
| 🔧 **MCP Commands** | `/mcp list`, `/mcp connect`, `/mcp disconnect` |

### UI & Experience

| Feature | Description |
|---------|-------------|
| 📋 **Tabbed Command Palette** | Sessions, Providers, Mode, Actions — all from one menu |
| 📝 **Markdown Chat** | Messages render with full Markdown support |
| 🧩 **Skills System** | Lazy-loaded `.md` skill files from `.klyxor/skills/` |
| 💾 **Session Persistence** | Sessions saved to `.klyxor/sessions.json` |
| ⏳ **Animated Spinner** | Visual loading indicator with tool name display |
| ⚡ **Tool Display** | Structured tool call/result display in chat |
| 📦 **Context Compaction** | Auto-summarizes old conversation turns when messages exceed threshold |
| 📂 **Project Context** | Auto-loads `AGENTS.md` / `KLYXOR.md` / `.klyxor/context.md` |
| 💰 **Token & Cost Tracking** | Per-model usage statistics and estimated costs |
| 📝 **Session Export** | Export chat transcripts to Markdown files |
| 🔑 **Env-Var API Keys** | API keys support `${ENV_VAR}` expansion with `KLYXOR_API_KEY` fallback |

---

## 🚀 Quick Start

```bash
# Install globally via npm
npm install -g @alnyx/klyxor

# Run from any directory
klyxor

# Or use one-shot mode
klyxor --plan "analyze this project"
klyxor --build "add a new API endpoint"
```

For development:

```bash
npm run dev          # Run with tsx (hot reload)
npm run build        # Build to dist/
```

On first launch, klyxor creates `~/.klyxor/` in your home directory with config, sessions, and skills.

---

## ⚙️ Configuration

All configuration lives in `~/.klyxor/` (your home directory):

```
~/.klyxor/
├── config.json       # Provider settings, API keys, active model, MCP servers
├── sessions.json     # Chat session history
├── skills/           # Custom skill files (.md)
├── tools/            # Custom tool definitions (.json)
├── snapshots/        # Time Machine snapshots
└── exports/          # Exported session transcripts
```

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

### MCP Servers

Configure MCP servers in `~/.klyxor/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "my-server",
      "transport": "stdio",
      "command": "node",
      "args": ["./my-mcp-server.js"]
    }
  ]
}
```

Then connect:
```
/mcp list
/mcp connect my-server
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
├── cli.tsx                  # Entry point
├── agent.ts                 # Core agent loop (tool-calling)
├── llm.ts                   # LLM HTTP client with streaming + error recovery
├── tools.ts                 # Tool definitions (30+ tools)
├── commands.ts              # Slash commands
├── config.ts                # Provider config, MCP config, .klyxor/ init
├── constants.ts             # Centralized constants
├── sessions.ts              # Session persistence + todo list
├── skills.ts                # Skill system
├── usage.ts                 # Token/cost tracking per model
├── compact.ts               # Context compaction (summarize old turns)
├── context.ts               # Project context auto-loader
├── export.ts                # Session export to Markdown
├── mcp.ts                   # MCP client manager
├── refactoring-engine.ts    # Code analysis + refactoring
├── multi-agent.ts           # Multi-agent orchestrator
├── time-machine.ts          # Codebase snapshots + branching
├── predictive-bugs.ts       # Pattern-based bug detection
├── subagent-pool.ts         # Parallel subagent execution
├── git-worktree.ts          # Git worktree management
├── custom-tools.ts          # User-defined tools
├── pipeline.ts              # Command chaining engine
├── update-checker.ts        # npm update checker
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
| ⏱️ Timeouts | Bash (120s), LLM fetch (120s), web fetch (20s), MCP (30s) |
| 📊 Limits | Max turns (200), file read (2000 lines), grep results (200) |
| 🎨 UI | Brand color (`#51ff48`), separator widths, preview lengths |
| 🤖 LLM | Temperature (0.1), max tokens (4096), endpoint, retry (3 attempts) |
| 🛡️ Error Recovery | Max retries (3), base delay (1s), max delay (30s), fallback model |
| ⚡ Streaming | Stream enabled by default |
| 📦 Compaction | Threshold (60 messages), keep recent (20) |
| 🔌 MCP | Connect timeout (30s), tool call timeout (60s), max tools (100) |
| 🔍 Refactoring | Max file lines (500), duplication threshold, complexity threshold |
| 🤖 Multi-Agent | Max concurrent (5), task timeout (120s) |
| ⏰ Time Machine | Max snapshots (100), max files (50) |
| 🐛 Predictive Bugs | Max nesting (5), max function length (50), max returns (10) |
| 🌳 Git Worktree | Base dir (`.klyxor/worktrees`) |
| 🛠️ Custom Tools | Tools dir (`.klyxor/tools`), max tools (50) |
| 🔗 Pipeline | Max steps (20), step timeout (60s) |
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
| `/mcp list` | List MCP servers and their tools |
| `/mcp connect <name>` | Connect to an MCP server |
| `/mcp disconnect <name>` | Disconnect from an MCP server |
| `/update` | Check for klyxor updates |
| `/exit`, `/quit` | Save and exit |

---

## 📄 License

[ISC](LICENSE)
