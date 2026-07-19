# klyxor

A coding agent with Plan/Build modes, subagent delegation, lazy-loaded skills, and a terminal chat interface.

## Features

- **Plan/Build modes** — separate planning and execution phases for structured workflows
- **Subagent delegation** — spawn specialized agents for parallel task execution
- **Lazy-loaded skills** — on-demand skill loading for efficient resource usage
- **Terminal chat interface** — interactive CLI powered by Ink (React for terminals)

## Installation

```bash
npm install
```

## Usage

```bash
# Development
npm run dev

# Build
npm run build
```

## Project Structure

```
src/
├── agent.ts      — Core agent logic
├── cli.tsx       — Entry point (TUI)
├── commands.ts   — Command definitions
├── config.ts     — Configuration management
├── llm.ts        — LLM integration
├── sessions.ts   — Session handling
├── skills.ts     — Skill system
├── tools.ts      — Tool definitions
└── tui/          — Terminal UI components
```

## License

ISC
