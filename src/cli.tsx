#!/usr/bin/env node

/**
 * Klyxor — CLI entry point.
 *
 * Usage:
 *   npx tsx src/cli.tsx                          # TUI mode (Ink)
 *   npx tsx src/cli.tsx [--plan|--build] <task>   # one-shot mode
 */

import React from "react";
import { render } from "ink";
import {
  ensureKlyxorDir,
  loadConfig,
} from "./config.js";
import { loadState, SessionManager, saveState } from "./sessions.js";
import { runAgent } from "./agent.js";
import { App } from "./tui/App.js";

const args = process.argv.slice(2);

// --help flag
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Klyxor — a coding agent with Plan/Build modes.

Usage:
  klyxor                              # TUI mode (requires ink)
  klyxor [--plan|--build] <task>      # one-shot mode
  klyxor --help                       # show this message

Options:
  --plan     Run in Plan mode (read-only investigation)
  --build    Run in Build mode (full execution, default)

On first run, creates .klyxor/ in your working directory for state.`);
  process.exit(0);
}

if (args.length > 0) {
  ensureKlyxorDir();
  loadConfig();

  let mode = "build";
  let taskArgs = args;

  if (args[0] === "--plan" || args[0] === "--build") {
    mode = args[0].slice(2);
    taskArgs = args.slice(1);
  }

  const prompt = taskArgs.join(" ").trim();
  if (!prompt) {
    console.error(
      `Usage:\n  klyxor                              # TUI mode\n` +
        `  klyxor [--plan|--build] <task>   # one-shot`
    );
    process.exit(1);
  }

  const finalAnswer = await runAgent(prompt, mode);
  console.log(
    `\n${"#".repeat(60)}\nFINAL ANSWER\n${"#".repeat(60)}\n${finalAnswer}`
  );
  process.exit(0);
}

ensureKlyxorDir();
loadConfig();

const restored = loadState();
const manager = restored || new SessionManager();

const { waitUntilExit } = render(
  React.createElement(App, { manager })
);

waitUntilExit().then(() => {
  saveState(manager);
  process.exit(0);
});
