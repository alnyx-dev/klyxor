import {
  connectCommand,
  getActiveProviderName,
  listProvidersText,
  setActiveProviderName,
  getProviders,
  addProvider,
  saveConfig,
} from "./config.js";
import { discoverSkills } from "./skills.js";
import { SessionManager, saveState } from "./sessions.js";

export const HELP_TEXT = `\
Commands:
  /plan              switch current session to Plan mode (read-only)
  /build             switch current session to Build mode (full execution)
  /skills            list available skills (.klyxor/skills/*.md)
  /reset             clear current session's history (keeps its mode)
  /sessions          list sessions
  /sessions <name>   switch to session <name>
  /new [name]        create a new session (auto-named if omitted) and switch to it
  /connect [name]    switch LLM provider by name, or with no name: list/add providers
  /help              show this message
  /exit, /quit       leave the chat
Anything else is sent to the agent as a chat message in the current session.`;

export type CommandResult =
  | { type: "exit" }
  | { type: "handled"; message?: string }
  | { type: "chat"; text: string };

export function handleCommand(
  text: string,
  manager: SessionManager
): CommandResult {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ").trim();

  if (cmd === "/exit" || cmd === "/quit") {
    saveState(manager);
    return { type: "exit" };
  }

  if (cmd === "/help") {
    return { type: "handled", message: HELP_TEXT };
  }

  if (cmd === "/plan") {
    manager.active.setMode("plan");
    saveState(manager);
    return { type: "handled", message: "→ switched to PLAN mode (read-only)" };
  }

  if (cmd === "/build") {
    manager.active.setMode("build");
    saveState(manager);
    return {
      type: "handled",
      message: "→ switched to BUILD mode (full access)",
    };
  }

  if (cmd === "/reset") {
    manager.active.reset();
    saveState(manager);
    return { type: "handled", message: "→ history cleared" };
  }

  if (cmd === "/skills") {
    const skills = discoverSkills();
    if (Object.keys(skills).length === 0) {
      return { type: "handled", message: "No skills available." };
    }
    const lines = Object.entries(skills)
      .map(([n, info]) => `- ${n}: ${info.description}`)
      .join("\n");
    return { type: "handled", message: lines };
  }

  if (cmd === "/sessions") {
    if (arg) {
      try {
        manager.switch(arg);
        saveState(manager);
        return {
          type: "handled",
          message: `→ switched to session '${arg}'`,
        };
      } catch {
        return {
          type: "handled",
          message: `Unknown session '${arg}'. Run /sessions with no argument to list.`,
        };
      }
    }
    return { type: "handled", message: manager.listText() };
  }

  if (cmd === "/new") {
    try {
      const created = manager.newSession(arg || undefined, "build", true);
      saveState(manager);
      return {
        type: "handled",
        message: `→ created and switched to session '${created}'`,
      };
    } catch (e) {
      return { type: "handled", message: String(e) };
    }
  }

  if (cmd === "/connect") {
    if (arg) {
      // Handle "new" subcommand for interactive add
      if (arg === "new") {
        // In non-interactive mode, we can't add providers interactively.
        // User should edit .klyxor/config.json directly.
        return {
          type: "handled",
          message:
            "Edit .klyxor/config.json directly to add a new provider, or use /connect <name> to switch.",
        };
      }
      const result = connectCommand(arg);
      saveConfig();
      return { type: "handled", message: result };
    }
    // List providers
    const text = listProvidersText();
    return {
      type: "handled",
      message: `${text}\nUse /connect <name> to switch, or edit .klyxor/config.json to add.`,
    };
  }

  return {
    type: "handled",
    message: `Unknown command: ${cmd}. Type /help for available commands.`,
  };
}
