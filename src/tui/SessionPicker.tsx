import React, { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { SessionManager, saveState } from "../sessions.js";
import { BRAND_COLOR } from "../constants.js";

interface SessionPickerProps {
  manager: SessionManager;
  onSelect: (name: string) => void;
  onCancel: () => void;
}

interface SessionRow {
  name: string;
  mode: string;
  nMsgs: number;
  isCurrent: boolean;
}

export function SessionPicker({ manager, onSelect, onCancel }: SessionPickerProps) {
  const rows: SessionRow[] = manager.order
    .filter((name) => !manager.sessions.get(name)?.unsaved)
    .map((name) => {
      const s = manager.sessions.get(name)!;
      return {
        name,
        mode: s.mode,
        nMsgs: s.messages.filter((m) => m.role === "user").length,
        isCurrent: name === manager.current,
      };
    });

  const [cursor, setCursor] = useState(0);

  useInput((inputStr, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow || inputStr === "k") {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || inputStr === "j") {
      setCursor((c) => Math.min(rows.length - 1, c + 1));
      return;
    }
    if (key.return) {
      if (rows.length > 0) {
        onSelect(rows[cursor].name);
      }
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BRAND_COLOR} padding={1}>
      <Text bold>Select session:</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.length === 0 ? (
          <Text dimColor>No sessions yet</Text>
        ) : (
          rows.map((row, i) => (
            <Text key={row.name}>
              <Text>{i === cursor ? "▸ " : "  "}</Text>
              <Text bold={row.isCurrent} color={row.isCurrent ? BRAND_COLOR : undefined}>
                {row.isCurrent ? `*${row.name}` : ` ${row.name}`}
              </Text>
              <Text> [{row.mode}] {row.nMsgs} msg{row.nMsgs !== 1 ? "s" : ""}</Text>
            </Text>
          ))
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Enter = select, Esc = cancel, j/k = navigate
        </Text>
      </Box>
    </Box>
  );
}
