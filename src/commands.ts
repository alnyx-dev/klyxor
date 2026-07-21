import {
  connectCommand,
  getActiveProviderName,
  listProvidersText,
  setActiveProviderName,
  getProviders,
  addProvider,
  saveConfig,
  getActiveModel,
  setActiveModel,
  getMcpServer,
  getMcpServers,
} from "./config.js";
import { discoverSkills, createSkill, getSkillInfo, findMatchingSkills } from "./skills.js";
import { SessionManager, saveState } from "./sessions.js";
import { MODE_PLAN, MODE_BUILD, DEFAULT_MODE } from "./constants.js";
import { usageTracker } from "./usage.js";
import { exportSessionMarkdown } from "./export.js";
import { compactMessages } from "./compact.js";
import { buildToolsForAgent } from "./agent.js";
import { mcpManager } from "./mcp.js";
import { checkForUpdate, formatUpdateNotification } from "./update-checker.js";

export const HELP_TEXT = `\
Commands:
  /plan              switch current session to Plan mode (read-only)
  /build             switch current session to Build mode (full execution)
  /skills            list available skills (.klyxor/skills/*.md)
  /skills create <name>  create a new skill with YAML frontmatter
  /skills info <name>    show detailed info about a skill
  /skills find <file|task>  find skills matching a file or task
  /reset             clear current session's history (keeps its mode)
  /sessions          list sessions
  /sessions <name>   switch to session <name>
  /new [name]        create a new session (auto-named if omitted) and switch to it
  /connect [name]    switch LLM provider by name, or with no name: list/add providers
  /cost              show token usage and estimated cost for this session
  /tokens            same as /cost — show token usage summary
  /model [name]      show current model, or switch if a model name is given
  /tools             list available tools in the current mode
  /export [path]     export current session transcript to a Markdown file
  /compact           manually compress conversation history (saves context)
  /mcp               manage MCP server connections
  /update            check for klyxor updates
  /help              show this message
  /exit, /quit       leave the chat
Anything else is sent to the agent as a chat message in the current session.`;

export type CommandResult =
  | { type: "exit" }
  | { type: "handled"; message?: string; sessionChanged?: boolean }
  | { type: "chat"; text: string };

export async function handleCommand(
  text: string,
  manager: SessionManager
): Promise<CommandResult> {
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
    manager.active.setMode(MODE_PLAN);
    saveState(manager);
    return { type: "handled", message: "→ switched to PLAN mode (read-only)" };
  }

  if (cmd === "/build") {
    manager.active.setMode(MODE_BUILD);
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
    // /skills with no args = list
    if (!arg) {
      const skills = discoverSkills();
      if (Object.keys(skills).length === 0) {
        return { type: "handled", message: "No skills available." };
      }
      const lines = Object.entries(skills)
        .map(([n, info]) => {
          const tags = info.metadata.tags ? ` [${info.metadata.tags.join(", ")}]` : "";
          const triggers = info.metadata.triggers ? ` (${info.metadata.triggers.join(", ")})` : "";
          return `- ${n}: ${info.description}${tags}${triggers}`;
        })
        .join("\n");
      return { type: "handled", message: lines };
    }

    // /skills create <name>
    if (arg.startsWith("create ")) {
      const skillName = arg.slice(7).trim();
      if (!skillName) {
        return { type: "handled", message: "Usage: /skills create <name>" };
      }
      const result = createSkill(skillName);
      return { type: "handled", message: result };
    }

    // /skills info <name>
    if (arg.startsWith("info ")) {
      const skillName = arg.slice(5).trim();
      if (!skillName) {
        return { type: "handled", message: "Usage: /skills info <name>" };
      }
      const info = getSkillInfo(skillName);
      return { type: "handled", message: info };
    }

    // /skills find <query>
    if (arg.startsWith("find ")) {
      const query = arg.slice(5).trim();
      if (!query) {
        return { type: "handled", message: "Usage: /skills find <file|task>" };
      }
      const matches = findMatchingSkills(query, query);
      if (matches.length === 0) {
        return { type: "handled", message: "No matching skills found." };
      }
      const skills = discoverSkills();
      const lines = matches
        .map((n) => `- ${n}: ${skills[n]?.description || ""}`)
        .join("\n");
      return { type: "handled", message: lines };
    }

    return { type: "handled", message: "Usage: /skills [create|info|find] [args]" };
  }

  if (cmd === "/sessions") {
    if (arg) {
      try {
        manager.switch(arg);
        saveState(manager);
        return {
          type: "handled",
          message: `→ switched to session '${arg}'`,
          sessionChanged: true,
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
      const created = manager.newSession(arg || undefined, DEFAULT_MODE, true);
      saveState(manager);
      return {
        type: "handled",
        message: `→ created and switched to session '${created}'`,
        sessionChanged: true,
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

  if (cmd === "/cost" || cmd === "/tokens") {
    const report = usageTracker.report();
    return { type: "handled", message: report };
  }

  if (cmd === "/model") {
    if (arg) {
      // Try to switch model
      const provider = getActiveProviderName();
      const result = setActiveModel(provider, arg);
      saveConfig();
      return { type: "handled", message: result };
    }
    // Show current model
    const model = getActiveModel();
    const provider = getActiveProviderName();
    return { type: "handled", message: `Current model: ${model} (provider: ${provider})` };
  }

  if (cmd === "/tools") {
    // Build tool list for current session mode
    const session = manager.active;
    const toolsMap = buildToolsForAgent(session.mode, 0, () => {});
    const names = Array.from(toolsMap.keys());
    return { type: "handled", message: `Available tools (${session.mode} mode):\n${names.map(n => `  - ${n}`).join("\n")}` };
  }

  if (cmd === "/export") {
    const session = manager.active;
    const name = manager.current;
    try {
      const outPath = arg || undefined;
      const filePath = exportSessionMarkdown(session, name, outPath);
      return { type: "handled", message: `Session exported to: ${filePath}` };
    } catch (e) {
      return { type: "handled", message: `Export failed: ${e}` };
    }
  }

  if (cmd === "/compact") {
    const session = manager.active;
    const before = session.messages.length;
    try {
      session.messages = await compactMessages(session.messages);
      const after = session.messages.length;
      saveState(manager);
      return { type: "handled", message: `Compacted: ${before} → ${after} messages` };
    } catch (e) {
      return { type: "handled", message: `Compact failed: ${e}` };
    }
  }

  if (cmd === "/mcp") {
    const subcommand = parts[1]?.toLowerCase();
    const serverName = parts[2];

    if (!subcommand || subcommand === "list") {
      const connected = mcpManager.listConnected();
      const configured = getMcpServers();
      let output = connected;
      if (configured.length > 0) {
        output += `\n\nConfigured servers: ${configured.map((s) => s.name).join(", ")}`;
      }
      output += "\n\nUsage: /mcp list | /mcp connect <name> | /mcp disconnect <name>";
      return { type: "handled", message: output };
    }

    if (subcommand === "connect") {
      if (!serverName) {
        return { type: "handled", message: "Usage: /mcp connect <server-name>" };
      }
      if (mcpManager.isConnected(serverName)) {
        return { type: "handled", message: `MCP server '${serverName}' is already connected.` };
      }
      const config = getMcpServer(serverName);
      if (!config) {
        const configured = getMcpServers();
        const names = configured.map((s) => s.name).join(", ") || "(none)";
        return {
          type: "handled",
          message: `MCP server '${serverName}' not found in config. Configured: ${names}`,
        };
      }
      const result = await mcpManager.connect(config);
      return { type: "handled", message: result };
    }

    if (subcommand === "disconnect") {
      if (!serverName) {
        return { type: "handled", message: "Usage: /mcp disconnect <server-name>" };
      }
      const result = await mcpManager.disconnect(serverName);
      return { type: "handled", message: result };
    }

    return {
      type: "handled",
      message: "Usage: /mcp list | /mcp connect <name> | /mcp disconnect <name>",
    };
  }

  if (cmd === "/update") {
    try {
      const info = await checkForUpdate();
      const notification = formatUpdateNotification(info);
      if (notification) {
        return { type: "handled", message: notification };
      }
      return {
        type: "handled",
        message: `✅ klyxor is up to date (v${info.currentVersion})`,
      };
    } catch (e) {
      return {
        type: "handled",
        message: `Error checking for updates: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return {
    type: "handled",
    message: `Unknown command: ${cmd}. Type /help for available commands.`,
  };
}
