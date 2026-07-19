import React, { useState, useCallback, useMemo } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { SessionManager } from "../sessions.js";
import {
  getProviders,
  getActiveProviderName,
  removeProvider,
  saveConfig,
} from "../config.js";

type PaletteItem =
  | { type: "header"; label: string }
  | { type: "session"; name: string; mode: string; nMsgs: number; isCurrent: boolean }
  | { type: "provider"; name: string; model: string; baseUrl: string; isActive: boolean }
  | { type: "mode"; mode: string; label: string; description: string; isActive: boolean }
  | { type: "action"; id: string; label: string; icon: string };

export interface CommandPaletteProps {
  manager: SessionManager;
  onSelectSession: (name: string) => void;
  onSelectProvider: (name: string) => void;
  onSwitchMode: (mode: string) => void;
  onAction: (actionId: string) => void;
  onCancel: () => void;
}

const MODE_INFO: Record<string, { label: string; description: string }> = {
  plan: { label: "Plan", description: "read-only" },
  build: { label: "Build", description: "full access" },
};

const HEADER_WIDTH = 38;

function buildItems(manager: SessionManager): PaletteItem[] {
  const items: PaletteItem[] = [];

  // Sessions
  items.push({ type: "header", label: "Sessions" });
  for (const name of manager.order) {
    const s = manager.sessions.get(name);
    if (!s) continue;
    items.push({
      type: "session",
      name,
      mode: s.mode,
      nMsgs: s.messages.filter((m) => m.role === "user").length,
      isCurrent: name === manager.current,
    });
  }

  // Providers
  items.push({ type: "header", label: "Providers" });
  const providers = getProviders();
  const activeProviderName = getActiveProviderName();
  for (const [name, p] of Object.entries(providers)) {
    items.push({
      type: "provider",
      name,
      model: p.model,
      baseUrl: p.base_url,
      isActive: name === activeProviderName,
    });
  }

  // Mode
  items.push({ type: "header", label: "Mode" });
  const currentMode = manager.active.mode;
  for (const [mode, info] of Object.entries(MODE_INFO)) {
    items.push({
      type: "mode",
      mode,
      label: info.label,
      description: info.description,
      isActive: mode === currentMode,
    });
  }

  // Actions
  items.push({ type: "header", label: "Actions" });
  items.push({ type: "action", id: "new-session", label: "New Session", icon: "+" });
  items.push({ type: "action", id: "reset-session", label: "Reset Session", icon: "r" });
  items.push({ type: "action", id: "skills", label: "Skills", icon: "s" });
  items.push({ type: "action", id: "help", label: "Help", icon: "?" });

  return items;
}

function selectableIndices(items: PaletteItem[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].type !== "header") {
      indices.push(i);
    }
  }
  return indices;
}

export const CommandPalette = React.memo(function CommandPalette({
  manager,
  onSelectSession,
  onSelectProvider,
  onSwitchMode,
  onAction,
  onCancel,
}: CommandPaletteProps) {
  const { stdout } = useStdout();
  const items = buildItems(manager);
  const selectables = selectableIndices(items);

  const [cursor, setCursor] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [subMode, setSubMode] = useState<"list" | "add-session" | "confirm-delete">("list");
  const [addInput, setAddInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{
    name: string;
    kind: "session" | "provider";
  } | null>(null);
  const [, forceRender] = useState(0);
  const refresh = useCallback(() => forceRender((n) => n + 1), []);

  const maxCursor = Math.max(0, selectables.length - 1);

  // Calculate viewport: terminal height minus fixed elements (header, footer, borders, padding)
  const viewportHeight = Math.max(5, stdout.rows - 8);

  // Ensure cursor is visible within viewport
  const ensureVisible = useCallback(
    (newCursor: number) => {
      if (newCursor < scrollOffset) {
        setScrollOffset(newCursor);
      } else if (newCursor >= scrollOffset + viewportHeight) {
        setScrollOffset(newCursor - viewportHeight + 1);
      }
    },
    [scrollOffset, viewportHeight]
  );

  useInput((inputStr, key) => {
    // -- add-session sub-mode: only handle Escape, let TextInput do the rest --
    if (subMode === "add-session") {
      if (key.escape) {
        setSubMode("list");
        setAddInput("");
      }
      return;
    }

    // -- confirm-delete sub-mode --
    if (subMode === "confirm-delete") {
      if (inputStr === "y" && deleteTarget) {
        if (deleteTarget.kind === "provider") {
          removeProvider(deleteTarget.name);
          saveConfig();
        } else {
          manager.sessions.delete(deleteTarget.name);
          manager.order = manager.order.filter((n) => n !== deleteTarget.name);
          if (manager.current === deleteTarget.name) {
            if (manager.order.length > 0) {
              manager.current = manager.order[0];
            } else {
              manager.newSession(undefined, "build", true);
            }
          }
        }
        setSubMode("list");
        setDeleteTarget(null);
        setCursor((c) => Math.min(c, Math.max(0, selectables.length - 1)));
        refresh();
        return;
      }
      if (inputStr === "n" || key.escape) {
        setSubMode("list");
        setDeleteTarget(null);
        return;
      }
      return;
    }

    // -- list mode --
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow || inputStr === "k") {
      setCursor((c) => {
        const next = Math.max(0, c - 1);
        ensureVisible(next);
        return next;
      });
      return;
    }
    if (key.downArrow || inputStr === "j") {
      setCursor((c) => {
        const next = Math.min(maxCursor, c + 1);
        ensureVisible(next);
        return next;
      });
      return;
    }

    if (key.return && selectables.length > 0) {
      const itemIdx = selectables[cursor];
      if (itemIdx === undefined) return;
      const item = items[itemIdx];
      switch (item.type) {
        case "session":
          onSelectSession(item.name);
          break;
        case "provider":
          onSelectProvider(item.name);
          break;
        case "mode":
          onSwitchMode(item.mode);
          break;
        case "action":
          if (item.id === "new-session") {
            setSubMode("add-session");
            setAddInput("");
          } else {
            onAction(item.id);
          }
          break;
      }
      return;
    }

    // n = new session (when cursor is on a session)
    if (inputStr === "n" && selectables.length > 0) {
      const itemIdx = selectables[cursor];
      if (itemIdx === undefined) return;
      const item = items[itemIdx];
      if (item.type === "session") {
        setSubMode("add-session");
        setAddInput("");
      }
      return;
    }

    // d = delete
    if (inputStr === "d" && selectables.length > 0) {
      const itemIdx = selectables[cursor];
      if (itemIdx === undefined) return;
      const item = items[itemIdx];
      if (item.type === "session" && item.name !== manager.current) {
        setDeleteTarget({ name: item.name, kind: "session" });
        setSubMode("confirm-delete");
      } else if (item.type === "provider" && Object.keys(getProviders()).length > 1) {
        setDeleteTarget({ name: item.name, kind: "provider" });
        setSubMode("confirm-delete");
      }
      return;
    }
  });

  const handleAddSubmit = useCallback(
    (text: string) => {
      const name = text.trim();
      setSubMode("list");
      setAddInput("");
      onAction(name ? `new-session:${name}` : "new-session");
    },
    [onAction]
  );

  // ── add-session sub-mode ──────────────────────
  if (subMode === "add-session") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="#DA7756"
        padding={1}
      >
        <Text bold>New session name:</Text>
        <Box marginTop={1}>
          <TextInput
            value={addInput}
            onChange={setAddInput}
            onSubmit={handleAddSubmit}
            placeholder={`session-${manager._counter + 1}`}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter = create, Esc = cancel</Text>
        </Box>
      </Box>
    );
  }

  // ── confirm-delete sub-mode ───────────────────
  if (subMode === "confirm-delete" && deleteTarget) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="#DA7756"
        padding={1}
      >
        <Text bold color="red">
          Delete {deleteTarget.kind} &quot;{deleteTarget.name}&quot;?
        </Text>
        <Box marginTop={1}>
          <Text>Press y to confirm, n or Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  // ── main list ─────────────────────────────────
  const safeCursor = Math.min(cursor, Math.max(0, selectables.length - 1));
  const selectedIdx = selectables[safeCursor];

  // Virtual scrolling: only render visible items
  const visibleItems = useMemo(() => {
    const result: { item: PaletteItem; originalIndex: number }[] = [];
    let visibleCount = 0;

    for (let i = 0; i < items.length; i++) {
      if (visibleCount >= scrollOffset && visibleCount < scrollOffset + viewportHeight) {
        result.push({ item: items[i], originalIndex: i });
      }
      visibleCount++;
      if (visibleCount >= scrollOffset + viewportHeight) break;
    }

    return result;
  }, [items, scrollOffset, viewportHeight]);

  const hasItemsAbove = scrollOffset > 0;
  const hasItemsBelow = scrollOffset + viewportHeight < items.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#DA7756"
      padding={1}
    >
      <Text bold>Command Palette</Text>

      <Box marginTop={1} flexDirection="column">
        {items.length === 0 ? (
          <Text dimColor>No items available</Text>
        ) : (
          <>
            {hasItemsAbove && (
              <Text dimColor>  ↑ {scrollOffset} more items above</Text>
            )}
            {visibleItems.map(({ item, originalIndex: i }) => {
              if (item.type === "header") {
                const headerLabel = `── ${item.label} `;
                const pad = Math.max(
                  1,
                  HEADER_WIDTH - headerLabel.length
                );
                return (
                  <Box key={`h-${i}`} marginTop={i > 0 ? 1 : 0}>
                    <Text dimColor>
                      {headerLabel}
                      {"─".repeat(pad)}
                    </Text>
                  </Box>
                );
              }

              const isSelected = i === selectedIdx;
              const prefix = isSelected ? (
                <Text color="#DA7756">{"▸ "}</Text>
              ) : (
                <Text>{"  "}</Text>
              );

              switch (item.type) {
                case "session":
                  return (
                    <Text key={item.name}>
                      {prefix}
                      <Text
                        bold={item.isCurrent}
                        color={item.isCurrent ? "#DA7756" : undefined}
                      >
                        {item.isCurrent
                          ? `*${item.name}`
                          : ` ${item.name}`}
                      </Text>
                      <Text>
                        {" "}
                        [{item.mode}] {item.nMsgs} msg
                        {item.nMsgs !== 1 ? "s" : ""}
                      </Text>
                    </Text>
                  );
                case "provider":
                  return (
                    <Text key={item.name}>
                      {prefix}
                      <Text
                        bold={item.isActive}
                        color={item.isActive ? "#DA7756" : undefined}
                      >
                        {item.isActive
                          ? `*${item.name}`
                          : ` ${item.name}`}
                      </Text>
                      <Text>
                        {" "}
                        [{item.model}] {item.baseUrl}
                      </Text>
                    </Text>
                  );
                case "mode":
                  return (
                    <Text key={item.mode}>
                      {prefix}
                      <Text
                        bold={item.isActive}
                        color={item.isActive ? "#DA7756" : undefined}
                      >
                        {item.isActive ? "* " : "  "}
                      </Text>
                      <Text>
                        {item.label} ({item.description})
                      </Text>
                    </Text>
                  );
                case "action":
                  return (
                    <Text key={item.id}>
                      {prefix}
                      <Text>
                        {item.icon} {item.label}
                      </Text>
                    </Text>
                  );
                default:
                  return null;
              }
            })}
            {hasItemsBelow && (
              <Text dimColor>  ↓ {items.length - scrollOffset - viewportHeight} more items below</Text>
            )}
          </>
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Enter = select, Esc = close, j/k = navigate
        </Text>
      </Box>
    </Box>
  );
});
