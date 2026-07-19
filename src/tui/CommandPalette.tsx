import React, { useState, useCallback, useMemo } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { SessionManager } from "../sessions.js";
import {
  getProviders,
  getActiveProviderName,
  getActiveModel,
  removeProvider,
  addModelToProvider,
  addProvider,
  setActiveModel,
  saveConfig,
} from "../config.js";
import { discoverSkills, createSkill, getSkillInfo } from "../skills.js";
import {
  BRAND_COLOR,
  PALETTE_UI_HEIGHT,
  MIN_VIEWPORT_HEIGHT,
  SESSION_NAME_PREFIX,
} from "../constants.js";

export interface CommandPaletteProps {
  manager: SessionManager;
  onSelectSession: (name: string) => void;
  onSelectProvider: (name: string) => void;
  onSwitchMode: (mode: string) => void;
  onAction: (actionId: string) => void;
  onCancel: () => void;
}

// ── Section definitions ──────────────────────────────────
type SectionId = "sessions" | "providers" | "mode" | "skills" | "actions";

interface SectionDef {
  id: SectionId;
  label: string;
  shortcut: string;
}

const SECTIONS: SectionDef[] = [
  { id: "sessions", label: "Sessions", shortcut: "1" },
  { id: "providers", label: "Providers", shortcut: "2" },
  { id: "mode", label: "Mode", shortcut: "3" },
  { id: "skills", label: "Skills", shortcut: "4" },
  { id: "actions", label: "Actions", shortcut: "5" },
];

const MODE_INFO: Record<string, { label: string; description: string }> = {
  plan: { label: "Plan", description: "read-only" },
  build: { label: "Build", description: "full access" },
};

// ── Item types per section ───────────────────────────────
interface SessionItem {
  type: "session";
  name: string;
  mode: string;
  nMsgs: number;
  isCurrent: boolean;
}

interface ProviderItem {
  type: "provider";
  name: string;
  model: string;
  models: string[];
  baseUrl: string;
  isActive: boolean;
}

interface ModeItem {
  type: "mode";
  mode: string;
  label: string;
  description: string;
  isActive: boolean;
}

interface ActionItem {
  type: "action";
  id: string;
  label: string;
  icon: string;
}

interface SkillItem {
  type: "skill";
  name: string;
  description: string;
  tags: string[];
  triggers: string[];
}

type SectionItem = SessionItem | ProviderItem | ModeItem | SkillItem | ActionItem;

// ── Build items per section ──────────────────────────────
function buildSectionItems(section: SectionId, manager: SessionManager): SectionItem[] {
  const items: SectionItem[] = [];

  switch (section) {
    case "sessions":
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
      break;

    case "providers": {
      const providers = getProviders();
      const activeProviderName = getActiveProviderName();
      for (const [name, p] of Object.entries(providers)) {
        items.push({
          type: "provider",
          name,
          model: getActiveModel(p),
          models: p.models || [],
          baseUrl: p.base_url,
          isActive: name === activeProviderName,
        });
      }
      break;
    }

    case "mode": {
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
      break;
    }

    case "actions":
      items.push({ type: "action", id: "new-session", label: "New Session", icon: "+" });
      items.push({ type: "action", id: "reset-session", label: "Reset Session", icon: "r" });
      items.push({ type: "action", id: "help", label: "Help", icon: "?" });
      break;

    case "skills": {
      const skills = discoverSkills();
      for (const [name, info] of Object.entries(skills)) {
        items.push({
          type: "skill",
          name,
          description: info.description,
          tags: info.metadata.tags || [],
          triggers: info.metadata.triggers || [],
        });
      }
      break;
    }
  }

  return items;
}

// ── Component ────────────────────────────────────────────
export function CommandPalette({
  manager,
  onSelectSession,
  onSelectProvider,
  onSwitchMode,
  onAction,
  onCancel,
}: CommandPaletteProps) {
  const { stdout } = useStdout();

  const [activeTab, setActiveTab] = useState<SectionId>("sessions");
  const [cursor, setCursor] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [subMode, setSubMode] = useState<"list" | "add-session" | "add-model" | "add-provider" | "select-model" | "skill-info" | "add-skill" | "confirm-delete">("list");
  const [addInput, setAddInput] = useState("");
  const [modelTarget, setModelTarget] = useState<string | null>(null);
  const [selectModelTarget, setSelectModelTarget] = useState<string | null>(null);
  const [providerForm, setProviderForm] = useState<{
    step: number;
    name: string;
    base_url: string;
    model: string;
    api_key: string;
  }>({ step: 0, name: "", base_url: "", model: "", api_key: "" });
  const [deleteTarget, setDeleteTarget] = useState<{
    name: string;
    kind: "session" | "provider";
  } | null>(null);
  const [, forceRender] = useState(0);
  const refresh = useCallback(() => forceRender((n) => n + 1), []);

  const items = useMemo(() => buildSectionItems(activeTab, manager), [activeTab, manager]);
  const maxCursor = Math.max(0, items.length - 1);
  const viewportHeight = Math.max(MIN_VIEWPORT_HEIGHT, stdout.rows - PALETTE_UI_HEIGHT - 3); // extra rows for tabs + footer

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

  // ── Tab index helpers ──────────────────────────────────
  const tabIndex = SECTIONS.findIndex((s) => s.id === activeTab);

  const switchTab = useCallback(
    (delta: number) => {
      const next = (tabIndex + delta + SECTIONS.length) % SECTIONS.length;
      setActiveTab(SECTIONS[next].id);
      setCursor(0);
      setScrollOffset(0);
    },
    [tabIndex]
  );

  // ── Keyboard handling ──────────────────────────────────
  useInput((inputStr, key) => {
    // -- add-session sub-mode --
    if (subMode === "add-session") {
      if (key.escape) {
        setSubMode("list");
        setAddInput("");
      }
      return;
    }

    // -- add-model sub-mode --
    if (subMode === "add-model") {
      if (key.escape) {
        setSubMode("list");
        setAddInput("");
        setModelTarget(null);
      }
      return;
    }

    // -- add-provider sub-mode --
    if (subMode === "add-provider") {
      if (key.escape) {
        setSubMode("list");
        setProviderForm({ step: 0, name: "", base_url: "", model: "", api_key: "" });
        setAddInput("");
      }
      return;
    }

    // -- select-model sub-mode --
    if (subMode === "select-model") {
      if (key.escape) {
        setSubMode("list");
        setSelectModelTarget(null);
        setCursor(0);
        setScrollOffset(0);
      }
      if ((key.upArrow || inputStr === "k") && selectModelTarget) {
        const models = getProviders()[selectModelTarget]?.models || [];
        setCursor((c) => Math.max(0, c - 1));
      }
      if ((key.downArrow || inputStr === "j") && selectModelTarget) {
        const models = getProviders()[selectModelTarget]?.models || [];
        setCursor((c) => Math.min(models.length - 1, c + 1));
      }
      if (key.return && selectModelTarget) {
        const models = getProviders()[selectModelTarget]?.models || [];
        const selectedModel = models[cursor];
        if (selectedModel) {
          setActiveModel(selectModelTarget, selectedModel);
          saveConfig();
        }
        setSubMode("list");
        setSelectModelTarget(null);
        setCursor(0);
        setScrollOffset(0);
        refresh();
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
        setCursor((c) => Math.min(c, Math.max(0, items.length - 1)));
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

    // -- skill-info sub-mode --
    if (subMode === "skill-info") {
      if (key.escape || key.return) {
        setSubMode("list");
        setCursor(0);
        setScrollOffset(0);
      }
      return;
    }

    // -- add-skill sub-mode --
    if (subMode === "add-skill") {
      if (key.escape) {
        setSubMode("list");
        setAddInput("");
      }
      return;
    }

    // -- list mode (normal) --
    if (key.escape) {
      onCancel();
      return;
    }

    // Tab switching: left/right arrows or number keys
    if (key.leftArrow || inputStr === "h") {
      switchTab(-1);
      return;
    }
    if (key.rightArrow || inputStr === "l") {
      switchTab(1);
      return;
    }
    // Number shortcuts for tabs
    if (inputStr === "1") { setActiveTab("sessions"); setCursor(0); setScrollOffset(0); return; }
    if (inputStr === "2") { setActiveTab("providers"); setCursor(0); setScrollOffset(0); return; }
    if (inputStr === "3") { setActiveTab("mode"); setCursor(0); setScrollOffset(0); return; }
    if (inputStr === "4") { setActiveTab("skills"); setCursor(0); setScrollOffset(0); return; }
    if (inputStr === "5") { setActiveTab("actions"); setCursor(0); setScrollOffset(0); return; }

    // Item navigation
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

    // Select item
    if (key.return && items.length > 0) {
      const item = items[cursor];
      if (!item) return;
      switch (item.type) {
        case "session":
          onSelectSession(item.name);
          break;
        case "provider":
          if (item.models.length > 0) {
            // Show model selection for this provider
            setSelectModelTarget(item.name);
            setSubMode("select-model");
            setCursor(0);
            setScrollOffset(0);
          } else {
            onSelectProvider(item.name);
          }
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
        case "skill":
          setSubMode("skill-info");
          setCursor(0);
          setScrollOffset(0);
          break;
      }
      return;
    }

    // n = new session
    if (inputStr === "n" && activeTab === "sessions") {
      setSubMode("add-session");
      setAddInput("");
      return;
    }

    // a = add model (in providers tab)
    if (inputStr === "a" && activeTab === "providers" && items.length > 0) {
      const item = items[cursor];
      if (item && item.type === "provider") {
        setModelTarget(item.name);
        setSubMode("add-model");
        setAddInput("");
      }
      return;
    }

    // A = add provider (in providers tab)
    if (inputStr === "A" && activeTab === "providers") {
      setSubMode("add-provider");
      setProviderForm({ step: 0, name: "", base_url: "", model: "", api_key: "" });
      setAddInput("");
      return;
    }

    // d = delete
    if (inputStr === "d" && items.length > 0) {
      const item = items[cursor];
      if (!item) return;
      if (item.type === "session" && item.name !== manager.current) {
        setDeleteTarget({ name: item.name, kind: "session" });
        setSubMode("confirm-delete");
      } else if (item.type === "provider" && Object.keys(getProviders()).length > 1) {
        setDeleteTarget({ name: item.name, kind: "provider" });
        setSubMode("confirm-delete");
      }
      return;
    }

    // n = new skill (in skills tab)
    if (inputStr === "n" && activeTab === "skills") {
      setSubMode("add-skill");
      setAddInput("");
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

  const handleAddModelSubmit = useCallback(
    (text: string) => {
      const model = text.trim();
      if (model && modelTarget) {
        addModelToProvider(modelTarget, model);
        saveConfig();
      }
      setSubMode("list");
      setAddInput("");
      setModelTarget(null);
      refresh();
    },
    [modelTarget, refresh]
  );

  const handleAddProviderSubmit = useCallback(
    (text: string) => {
      const value = text.trim();
      const step = providerForm.step;

      if (step === 0) {
        // Name
        setProviderForm((f) => ({ ...f, step: 1, name: value }));
        setAddInput("");
      } else if (step === 1) {
        // Base URL
        setProviderForm((f) => ({ ...f, step: 2, base_url: value }));
        setAddInput("");
      } else if (step === 2) {
        // Model
        setProviderForm((f) => ({ ...f, step: 3, model: value }));
        setAddInput("");
      } else if (step === 3) {
        // API Key - final step
        const { name, base_url, model } = providerForm;
        if (name && base_url && model) {
          addProvider(name, base_url, model, value);
          saveConfig();
        }
        setSubMode("list");
        setProviderForm({ step: 0, name: "", base_url: "", model: "", api_key: "" });
        setAddInput("");
        refresh();
      }
    },
    [providerForm, refresh]
  );

  const handleAddSkillSubmit = useCallback(
    (text: string) => {
      const name = text.trim();
      if (name) {
        const result = createSkill(name);
        refresh();
      }
      setSubMode("list");
      setAddInput("");
    },
    [refresh]
  );

  // ── Pre-hooks for all render paths (must be before any early returns) ──
  const safeCursor = Math.min(cursor, Math.max(0, items.length - 1));

  const visibleItems = useMemo(() => {
    const result: { item: SectionItem; originalIndex: number }[] = [];
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

  // ── add-session sub-mode ──────────────────────────────
  if (subMode === "add-session") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={BRAND_COLOR}
        padding={1}
      >
        <Text bold>New session name:</Text>
        <Box marginTop={1}>
          <TextInput
            value={addInput}
            onChange={setAddInput}
            onSubmit={handleAddSubmit}
            placeholder={`${SESSION_NAME_PREFIX}${manager._counter + 1}`}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter = create, Esc = cancel</Text>
        </Box>
      </Box>
    );
  }

  // ── add-model sub-mode ──────────────────────────────
  if (subMode === "add-model" && modelTarget) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={BRAND_COLOR}
        padding={1}
      >
        <Text bold>
          Add model to <Text color={BRAND_COLOR}>{modelTarget}</Text>:
        </Text>
        <Box marginTop={1}>
          <TextInput
            value={addInput}
            onChange={setAddInput}
            onSubmit={handleAddModelSubmit}
            placeholder="gpt-4o"
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter = add, Esc = cancel</Text>
        </Box>
      </Box>
    );
  }

  // ── add-provider sub-mode ──────────────────────────
  if (subMode === "add-provider") {
    const step = providerForm.step;
    const labels = ["Provider name", "Base URL", "Model name", "API Key"];
    const placeholders = [
      "my-provider",
      "https://api.openai.com/v1",
      "gpt-4o",
      "sk-...",
    ];
    const showMask = step === 3; // mask API key

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={BRAND_COLOR}
        padding={1}
      >
        <Text bold>
          Add provider <Text dimColor>({step + 1}/4)</Text>
        </Text>
        <Box marginTop={1}>
          <Text>
            <Text color={BRAND_COLOR}>{labels[step]}:</Text>{" "}
          </Text>
          <TextInput
            value={addInput}
            onChange={setAddInput}
            onSubmit={handleAddProviderSubmit}
            placeholder={placeholders[step]}
            mask={showMask ? "*" : undefined}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter = next, Esc = cancel</Text>
        </Box>
      </Box>
    );
  }

  // ── confirm-delete sub-mode ───────────────────────────
  if (subMode === "confirm-delete" && deleteTarget) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={BRAND_COLOR}
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

  // ── select-model sub-mode ─────────────────────────────
  if (subMode === "select-model" && selectModelTarget) {
    const provider = getProviders()[selectModelTarget];
    const models = provider?.models || [];
    const currentModel = provider ? getActiveModel(provider) : "";

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={BRAND_COLOR}
        padding={1}
      >
        <Text bold>
          Select model for <Text color={BRAND_COLOR}>{selectModelTarget}</Text>:
        </Text>
        <Box marginTop={1} flexDirection="column">
          {models.map((model, i) => (
            <Text key={model}>
              {i === cursor ? (
                <Text color={BRAND_COLOR}>{"▸ "}</Text>
              ) : (
                <Text>{"  "}</Text>
              )}
              <Text
                bold={model === currentModel}
                color={model === currentModel ? BRAND_COLOR : undefined}
              >
                {model === currentModel ? `* ${model}` : `  ${model}`}
              </Text>
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter = select, Esc = cancel</Text>
        </Box>
      </Box>
    );
  }

  // ── skill-info sub-mode ──────────────────────────────
  if (subMode === "skill-info") {
    const skillItem = items.find((it, i) => i === safeCursor && it.type === "skill") as SkillItem | undefined;
    if (skillItem) {
      const info = getSkillInfo(skillItem.name);
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={BRAND_COLOR}
          padding={1}
        >
          <Text bold color={BRAND_COLOR}>{skillItem.name}</Text>
          <Box marginTop={1}>
            <Text>{info}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Enter/Esc = back</Text>
          </Box>
        </Box>
      );
    }
    // fallback: no skill selected
    setSubMode("list");
  }

  // ── add-skill sub-mode ──────────────────────────────
  if (subMode === "add-skill") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={BRAND_COLOR}
        padding={1}
      >
        <Text bold>New skill name:</Text>
        <Box marginTop={1}>
          <TextInput
            value={addInput}
            onChange={setAddInput}
            onSubmit={handleAddSkillSubmit}
            placeholder="my-skill"
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter = create, Esc = cancel</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={BRAND_COLOR}
      padding={1}
    >
      {/* ── Tab bar ─────────────────────────────────────── */}
      <Box>
        {SECTIONS.map((section, i) => {
          const isActive = section.id === activeTab;
          return (
            <Text key={section.id}>
              {i > 0 ? " " : ""}
              {isActive ? (
                <Text bold color={BRAND_COLOR}>
                  {section.label}
                </Text>
              ) : (
                <Text dimColor>{section.label}</Text>
              )}
            </Text>
          );
        })}
      </Box>

      {/* ── Section content ─────────────────────────────── */}
      <Box marginTop={1} flexDirection="column">
        {items.length === 0 ? (
          <Text dimColor>No items</Text>
        ) : (
          <>
            {hasItemsAbove && (
              <Text dimColor>  ↑ {scrollOffset} more</Text>
            )}
            {visibleItems.map(({ item, originalIndex: i }) => {
              const isSelected = i === safeCursor;
              const prefix = isSelected ? (
                <Text color={BRAND_COLOR}>{"▸ "}</Text>
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
                        color={item.isCurrent ? BRAND_COLOR : undefined}
                      >
                        {item.isCurrent ? `*${item.name}` : ` ${item.name}`}
                      </Text>
                      <Text>
                        {" "}
                        [{item.mode}] {item.nMsgs} msg{item.nMsgs !== 1 ? "s" : ""}
                      </Text>
                    </Text>
                  );
                case "provider":
                  return (
                    <Box key={item.name} flexDirection="column">
                      <Text>
                        {prefix}
                        <Text
                          bold={item.isActive}
                          color={item.isActive ? BRAND_COLOR : undefined}
                        >
                          {item.isActive ? `*${item.name}` : ` ${item.name}`}
                        </Text>
                        <Text>
                          {" "}
                          [{item.model}] {item.baseUrl}
                        </Text>
                      </Text>
                      {item.models.length > 0 && (
                        <Text dimColor>
                          {"    "}
                          models: {item.models.join(", ")}
                        </Text>
                      )}
                    </Box>
                  );
                case "mode":
                  return (
                    <Text key={item.mode}>
                      {prefix}
                      <Text
                        bold={item.isActive}
                        color={item.isActive ? BRAND_COLOR : undefined}
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
                case "skill":
                  return (
                    <Box key={item.name} flexDirection="column">
                      <Text>
                        {prefix}
                        <Text bold color={BRAND_COLOR}>
                          {item.name}
                        </Text>
                        <Text>
                          {" "}
                          <Text dimColor>{item.description}</Text>
                        </Text>
                      </Text>
                      {item.tags.length > 0 && (
                        <Text dimColor>
                          {"    "}
                          tags: {item.tags.join(", ")}
                        </Text>
                      )}
                    </Box>
                  );
                default:
                  return null;
              }
            })}
            {hasItemsBelow && (
              <Text dimColor>  ↓ {items.length - scrollOffset - viewportHeight} more</Text>
            )}
          </>
        )}
      </Box>

      {/* ── Footer ──────────────────────────────────────── */}
      <Box marginTop={1}>
        <Text dimColor>
          h/l = tab, j/k = nav, Enter = select, Esc = close
          {activeTab === "sessions" ? ", n = new, d = delete" : ""}
          {activeTab === "providers" ? ", a = add model, A = add provider, d = delete" : ""}
          {activeTab === "skills" ? ", n = new skill" : ""}
        </Text>
      </Box>
    </Box>
  );
}
