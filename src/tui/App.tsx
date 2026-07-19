import React, { useState, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { SessionManager, saveState } from "../sessions.js";
import {
  getActiveProviderName,
  getActiveProvider,
  setActiveProviderName,
  saveConfig,
} from "../config.js";
import { handleCommand, HELP_TEXT } from "../commands.js";
import { discoverSkills } from "../skills.js";
import { MarkdownText } from "./MarkdownText.js";
import { CommandPalette } from "./CommandPalette.js";

interface ChatEntry {
  role: "user" | "agent" | "error" | "system" | "tool";
  content: string;
}

interface AppProps {
  manager: SessionManager;
}

export function App({ manager }: AppProps) {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [, forceRender] = useState(0);
  const [showPalette, setShowPalette] = useState(false);

  const [chatLog, setChatLog] = useState<ChatEntry[]>(() =>
    loadSessionEntries(manager)
  );

  function loadSessionEntries(mgr: SessionManager): ChatEntry[] {
    const entries: ChatEntry[] = [];
    const session = mgr.active;
    for (const m of session.messages) {
      const role = m.role;
      const content =
        typeof m.content === "string" ? m.content : (m.content ?? "");
      if (!content) continue;
      if (role === "user") {
        entries.push({ role: "user", content });
      } else if (role === "assistant") {
        entries.push({ role: "agent", content });
      }
    }
    if (entries.length === 0) {
      entries.push({
        role: "system",
        content:
          "Welcome to klyxor! Your AI coding assistant.\n\nTry: \"explain this project\" or \"help me debug something\"\nCommands: /help /plan /build /sessions",
      });
    }
    return entries;
  }

  const syncStatus = useCallback(() => {
    forceRender((n) => n + 1);
  }, []);

  const currentSession = manager.current;
  const currentMode = manager.active.mode;
  const currentProvider = getActiveProviderName();
  const modelName = getActiveProvider().model;

  useInput((inputStr, key) => {
    if (key.ctrl && inputStr === "c") {
      saveState(manager);
      exit();
    }
    if (key.ctrl && inputStr === "l") {
      setChatLog([]);
    }
    if (key.ctrl && inputStr === "p") {
      setShowPalette(true);
    }
    if (key.ctrl && inputStr === "k") {
      setShowPalette(true);
    }
    if (key.tab && !busy) {
      const next = manager.active.mode === "plan" ? "build" : "plan";
      manager.active.setMode(next);
      syncStatus();
    }
  });

  const handlePaletteSessionSelect = useCallback(
    (name: string) => {
      try {
        manager.switch(name);
        setShowPalette(false);
        const entries: ChatEntry[] = [];
        for (const m of manager.active.messages) {
          const content =
            typeof m.content === "string" ? m.content : (m.content ?? "");
          if (!content) continue;
          if (m.role === "user") entries.push({ role: "user", content });
          else if (m.role === "assistant") entries.push({ role: "agent", content });
        }
        setChatLog(entries.length > 0 ? entries : [{
          role: "system",
          content: "Welcome to klyxor! Your AI coding assistant.\n\nTry: \"explain this project\" or \"help me debug something\"\nCommands: /help /plan /build /sessions",
        }]);
        syncStatus();
      } catch (e) {
        setChatLog((prev) => [
          ...prev,
          { role: "error", content: `Could not switch session: ${e}` },
        ]);
        setShowPalette(false);
      }
    },
    [manager, syncStatus]
  );

  const handlePaletteProviderSelect = useCallback(
    (name: string) => {
      setActiveProviderName(name);
      saveConfig();
      setShowPalette(false);
      syncStatus();
    },
    [syncStatus]
  );

  const handlePaletteModeSwitch = useCallback(
    (mode: string) => {
      manager.active.setMode(mode);
      setShowPalette(false);
      syncStatus();
    },
    [manager, syncStatus]
  );

  const handlePaletteAction = useCallback(
    (actionId: string) => {
      if (actionId.startsWith("new-session:")) {
        const name = actionId.slice("new-session:".length);
        try {
          manager.newSession(name || undefined, "build", true);
          setChatLog(loadSessionEntries(manager));
          setShowPalette(false);
          syncStatus();
        } catch (e) {
          setChatLog((prev) => [
            ...prev,
            { role: "error", content: `Could not create session: ${e}` },
          ]);
        }
      } else if (actionId === "reset-session") {
        manager.active.reset();
        setChatLog(loadSessionEntries(manager));
        setShowPalette(false);
        syncStatus();
      } else if (actionId === "skills") {
        const skills = discoverSkills();
        const text =
          Object.keys(skills).length === 0
            ? "No skills available."
            : Object.entries(skills)
                .map(([n, info]) => `- ${n}: ${info.description}`)
                .join("\n");
        setChatLog((prev) => [...prev, { role: "system", content: text }]);
        setShowPalette(false);
      } else if (actionId === "help") {
        setChatLog((prev) => [
          ...prev,
          { role: "system", content: HELP_TEXT },
        ]);
        setShowPalette(false);
      }
    },
    [manager, syncStatus]
  );

  const handlePaletteCancel = useCallback(() => {
    setShowPalette(false);
  }, []);

  const handleSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      setInput("");

      if (trimmed.startsWith("/")) {
        const result = handleCommand(trimmed, manager);
        switch (result.type) {
          case "exit":
            saveState(manager);
            exit();
            return;
          case "handled":
            if (result.sessionChanged) {
              // Reload chat log from the new session
              setChatLog(loadSessionEntries(manager));
            } else if (result.message) {
              setChatLog((prev) => [
                ...prev,
                { role: "system", content: result.message! },
              ]);
            }
            syncStatus();
            return;
          case "chat":
            break;
        }
      }

      setChatLog((prev) => [...prev, { role: "user", content: trimmed }]);
      setBusy(true);

      try {
        const answer = await manager.active.send(trimmed, (msg) => {
          setChatLog((prev) => [...prev, { role: "tool", content: msg }]);
        });
        setChatLog((prev) => [...prev, { role: "agent", content: answer }]);
        manager.active.unsaved = false;
        saveState(manager);
      } catch (e) {
        setChatLog((prev) => [
          ...prev,
          { role: "error", content: `Something went wrong: ${e}` },
        ]);
      } finally {
        setBusy(false);
        syncStatus();
      }
    },
    [manager, exit, syncStatus]
  );

  return (
    <Box flexDirection="column" height="100%">
      {showPalette ? (
        <CommandPalette
          manager={manager}
          onSelectSession={handlePaletteSessionSelect}
          onSelectProvider={handlePaletteProviderSelect}
          onSwitchMode={handlePaletteModeSwitch}
          onAction={handlePaletteAction}
          onCancel={handlePaletteCancel}
        />
      ) : (
      <>
      {/* ── chat log ──────────────────────────────── */}
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {chatLog.map((entry, i) => {
          switch (entry.role) {
            case "user":
              return (
                <Box key={i} marginTop={i === 0 ? 0 : 1} flexDirection="row">
                  <Text bold color="cyan">
                    {">"}{" "}
                  </Text>
                  <Text>{entry.content}</Text>
                </Box>
              );
            case "agent":
              return (
                <Box key={i} marginTop={1} flexDirection="column">
                  <Text>
                    <Text bold color="#DA7756">
                      {"•"}{" "}
                    </Text>
                  </Text>
                  <Box paddingLeft={1}>
                    <MarkdownText content={entry.content} />
                  </Box>
                </Box>
              );
            case "error":
              return (
                <Box key={i} marginTop={1}>
                  <Text color="red">
                    {"✗"} {entry.content}
                  </Text>
                </Box>
              );
            case "system":
              return (
                <Box key={i} marginTop={1} flexDirection="column">
                  <Text dimColor>
                    {"*"} {entry.content}
                  </Text>
                </Box>
              );
            case "tool":
              return (
                <Box key={i} marginTop={0} flexDirection="column">
                  <Text dimColor>
                    {"  "}
                    {entry.content.length > 200
                      ? entry.content.slice(0, 200) + "..."
                      : entry.content}
                  </Text>
                </Box>
              );
            default:
              return null;
          }
        })}
      </Box>

      {/* ── status bar ────────────────────────────── */}
      <Box paddingX={1}>
        <Text dimColor>{"─".repeat(50)}</Text>
      </Box>
      <Box paddingX={1}>
        <Text dimColor>
          <Text color="#DA7756">▸</Text>{" "}
          {currentMode}{"  │  "}{modelName}{"  │  "}{currentProvider}
        </Text>
      </Box>

      {/* ── input / thinking indicator ────────────── */}
      <Box paddingX={1} paddingTop={0}>
        {busy ? (
          <Box>
            <Text bold color="#DA7756">
              {"◐"} Analyzing your code...
            </Text>
          </Box>
        ) : (
          <Box flexDirection="row">
            <Text color="cyan" bold>{"> "}</Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              placeholder="Ask me anything about your code..."
            />
          </Box>
        )}
      </Box>

      {/* ── footer hints ──────────────────────────── */}
      <Box paddingX={1} paddingBottom={1}>
        <Text dimColor>
          Tab switch mode{" "}
          <Text dimColor>{"|"}</Text> Ctrl+C quit{" "}
          <Text dimColor>{"|"}</Text> Ctrl+L clear{" "}
          <Text dimColor>{"|"}</Text> Ctrl+P palette
        </Text>
      </Box>
      </>
      )}
    </Box>
  );
}
