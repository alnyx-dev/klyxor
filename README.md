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
├── tools.ts             # Tool definitions (bash, read/write/edit, delegate)
├── commands.ts          # Slash commands
├── config.ts            # Provider config, .klyxor/ init
├── constants.ts         # Centralized constants
├── sessions.ts          # Session persistence
├── skills.ts            # Skill system
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
| ⏱️ Timeouts | Bash (120s), LLM fetch (120s) |
| 📊 Limits | Max turns (200), file read (2000 lines), grep results (200) |
| 🎨 UI | Brand color (`#DA7756`), separator widths, preview lengths |
| 🤖 LLM | Temperature (0.1), max tokens (4096), endpoint |
| 📁 Skip | `.git`, `__pycache__`, `node_modules`, `.klyxor` |

---

## 📄 License

[ISC](LICENSE)
