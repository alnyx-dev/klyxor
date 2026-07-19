import React, { useState, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { SessionManager, saveState } from "../sessions.js";
import { getActiveProviderName } from "../config.js";
import { handleCommand } from "../commands.js";

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

  const [chatLog, setChatLog] = useState<ChatEntry[]>(() => {
    const entries: ChatEntry[] = [];
    const session = manager.active;
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
        content: "Klyxor TUI started. Type /help for commands.",
      });
    }
    return entries;
  });

  const syncStatus = useCallback(() => {
    forceRender((n) => n + 1);
  }, []);

  const currentSession = manager.current;
  const currentMode = manager.active.mode;
  const currentProvider = getActiveProviderName();

  useInput((inputStr, key) => {
    if (key.ctrl && inputStr === "c") {
      saveState(manager);
      exit();
    }
    if (key.ctrl && inputStr === "l") {
      setChatLog([]);
    }
    if (key.ctrl && inputStr === "s") {
      const text = manager.listText();
      setChatLog((prev) => [...prev, { role: "system", content: `Sessions:\n${text}` }]);
    }
  });

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
            if (result.message) {
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
          { role: "error", content: `Error: ${e}` },
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
      <Box padding={1}>
        <Text bold color="cyan">
          Klyxor
        </Text>
        <Text dimColor> — coding agent</Text>
      </Box>

      <Box paddingX={1} borderBottom={true}>
        <Text dimColor>
          session:{" "}
          <Text bold color="white">
            {currentSession}
          </Text>{" "}
          mode:{" "}
          <Text bold color="white">
            {currentMode}
          </Text>{" "}
          provider:{" "}
          <Text bold color="white">
            {currentProvider}
          </Text>
        </Text>
      </Box>

      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {chatLog.map((entry, i) => {
          switch (entry.role) {
            case "user":
              return (
                <Text key={i}>
                  <Text bold color="blue">
                    you:{" "}
                  </Text>
                  {entry.content}
                </Text>
              );
            case "agent":
              return (
                <Text key={i}>
                  <Text bold color="green">
                    agent:{" "}
                  </Text>
                  {entry.content}
                </Text>
              );
            case "error":
              return (
                <Text key={i} color="red">
                  {entry.content}
                </Text>
              );
            case "system":
              return (
                <Text key={i} dimColor>
                  {entry.content}
                </Text>
              );
            case "tool":
              return (
                <Text key={i} dimColor>
                  {"  "}
                  {entry.content.length > 200
                    ? entry.content.slice(0, 200) + "..."
                    : entry.content}
                </Text>
              );
            default:
              return null;
          }
        })}
      </Box>

      <Box paddingX={1} borderTop={true}>
        {busy ? (
          <Text dimColor>agent is thinking...</Text>
        ) : (
          <Box>
            <Text color="cyan">
              [{currentSession}:{currentMode}] you&gt;{" "}
            </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              placeholder="Type a message or /help for commands..."
            />
          </Box>
        )}
      </Box>

      <Box paddingX={1}>
        <Text dimColor>
          Ctrl+C quit | Ctrl+L clear | Ctrl+S sessions
        </Text>
      </Box>
    </Box>
  );
}
