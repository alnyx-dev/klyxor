import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import {
  getProviders,
  getActiveProviderName,
  addProvider,
  saveConfig,
  removeProvider,
  setActiveModel,
  addModelToProvider,
  removeModelFromProvider,
  getActiveModel,
  type Provider,
} from "../config.js";
import { BRAND_COLOR, PROVIDER_PLACEHOLDERS } from "../constants.js";

interface ProviderPickerProps {
  onSelect: (name: string) => void;
  onCancel: () => void;
  onAdded?: () => void;
}

interface ProviderRow {
  name: string;
  activeModel: string;
  models: string[];
  baseUrl: string;
  isActive: boolean;
}

export function ProviderPicker({
  onSelect,
  onCancel,
  onAdded,
}: ProviderPickerProps) {
  const providers = getProviders();
  const activeName = getActiveProviderName();

  const rows: ProviderRow[] = Object.entries(providers).map(
    ([name, p]) => ({
      name,
      activeModel: getActiveModel(p),
      models: p.models || [],
      baseUrl: p.base_url,
      isActive: name === activeName,
    })
  );

  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<
    "list" | "add" | "confirm-delete" | "models" | "add-model"
  >("list");
  const [addStep, setAddStep] = useState(0);
  const [addValues, setAddValues] = useState<string[]>([
    "",
    "",
    "",
    "",
  ]);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(
    null
  );
  const [modelProvider, setModelProvider] = useState<string | null>(null);
  const [modelCursor, setModelCursor] = useState(0);
  const [newModelName, setNewModelName] = useState("");

  const addLabels = [
    "Step 1/4: Provider name",
    "Step 2/4: Base URL",
    "Step 3/4: API key",
    "Step 4/4: Model name",
  ];

  const advanceAdd = useCallback(() => {
    if (addStep < 3) {
      setAddStep(addStep + 1);
    } else {
      const [name, baseUrl, apiKey, model] = addValues;
      addProvider(name, baseUrl, model, apiKey);
      saveConfig();
      setMode("list");
      setAddStep(0);
      setAddValues(["", "", "", ""]);
      if (onAdded) onAdded();
    }
  }, [addStep, addValues, onAdded]);

  const submitNewModel = useCallback(() => {
    if (!modelProvider || !newModelName.trim()) return;
    addModelToProvider(modelProvider, newModelName.trim());
    saveConfig();
    setNewModelName("");
    setMode("models");
    if (onAdded) onAdded();
  }, [modelProvider, newModelName, onAdded]);

  useInput((inputStr, key) => {
    if (mode === "list") {
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
      if (inputStr === "m" && rows.length > 0) {
        setModelProvider(rows[cursor].name);
        setModelCursor(0);
        setMode("models");
        return;
      }
      if (inputStr === "n") {
        setMode("add");
        setAddStep(0);
        setAddValues(["", "", "", ""]);
        return;
      }
      if (inputStr === "d" && rows.length > 0) {
        const target = rows[cursor];
        if (rows.length === 1) return;
        setDeleteTarget(target.name);
        setMode("confirm-delete");
        return;
      }
    } else if (mode === "models") {
      const provider = modelProvider ? providers[modelProvider] : null;
      const models = provider?.models || [];
      if (key.escape) {
        setMode("list");
        setModelProvider(null);
        return;
      }
      if (key.upArrow || inputStr === "k") {
        setModelCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow || inputStr === "j") {
        setModelCursor((c) => Math.min(models.length - 1, c + 1));
        return;
      }
      if (key.return && models.length > 0) {
        const selected = models[modelCursor];
        if (modelProvider && selected) {
          setActiveModel(modelProvider, selected);
          saveConfig();
          setMode("list");
          setModelProvider(null);
          if (onAdded) onAdded();
        }
        return;
      }
      if (inputStr === "n") {
        setMode("add-model");
        setNewModelName("");
        return;
      }
      if (inputStr === "d" && models.length > 0) {
        const selected = models[modelCursor];
        if (modelProvider && selected && models.length > 1) {
          removeModelFromProvider(modelProvider, selected);
          saveConfig();
          setModelCursor((c) => Math.min(c, models.length - 2));
          if (onAdded) onAdded();
        }
        return;
      }
    } else if (mode === "add-model") {
      if (key.escape) {
        setMode("models");
        setNewModelName("");
        return;
      }
    } else if (mode === "confirm-delete") {
      if (inputStr === "y" && deleteTarget) {
        removeProvider(deleteTarget);
        saveConfig();
        setMode("list");
        setDeleteTarget(null);
        if (onAdded) onAdded();
        return;
      }
      if (inputStr === "n" || key.escape) {
        setMode("list");
        setDeleteTarget(null);
        return;
      }
    }
  });

  /* ── add-model mode ────────────────────────── */
  if (mode === "add-model") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={BRAND_COLOR}
        padding={1}
      >
        <Text bold>Add model to "{modelProvider}"</Text>
        <Box marginTop={1}>
          <TextInput
            value={newModelName}
            onChange={setNewModelName}
            onSubmit={submitNewModel}
            placeholder={PROVIDER_PLACEHOLDERS.model}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter = add, Esc = cancel</Text>
        </Box>
      </Box>
    );
  }

  /* ── add mode ──────────────────────────────── */
  if (mode === "add") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={BRAND_COLOR}
        padding={1}
      >
        <Text bold>Add new provider</Text>
        <Box marginTop={1}>
          <Text>{addLabels[addStep]}</Text>
        </Box>
        <Box marginTop={1}>
          <TextInput
            value={addValues[addStep]}
            onChange={(val: string) => {
              const next = [...addValues];
              next[addStep] = val;
              setAddValues(next);
            }}
            onSubmit={advanceAdd}
            placeholder={
              addStep === 1
                ? PROVIDER_PLACEHOLDERS.baseUrl
                : addStep === 2
                  ? PROVIDER_PLACEHOLDERS.apiKey
                  : addStep === 3
                    ? PROVIDER_PLACEHOLDERS.model
                    : PROVIDER_PLACEHOLDERS.name
            }
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter = next step, Esc = cancel</Text>
        </Box>
      </Box>
    );
  }

  /* ── confirm-delete mode ───────────────────── */
  if (mode === "confirm-delete" && deleteTarget) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={BRAND_COLOR}
        padding={1}
      >
        <Text bold color="red">
          Delete provider "{deleteTarget}"?
        </Text>
        <Box marginTop={1}>
          <Text>
            Press y to confirm, n or Esc to cancel
          </Text>
        </Box>
      </Box>
    );
  }

  /* ── models mode ───────────────────────────── */
  if (mode === "models" && modelProvider) {
    const provider = providers[modelProvider];
    const models = provider?.models || [];
    const activeModel = provider ? getActiveModel(provider) : "";

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={BRAND_COLOR}
        padding={1}
      >
        <Text bold>
          Models for <Text color={BRAND_COLOR}>{modelProvider}</Text>:
        </Text>
        <Box marginTop={1} flexDirection="column">
          {models.length === 0 ? (
            <Text dimColor>No models configured</Text>
          ) : (
            models.map((m, i) => {
              const isActive = m === activeModel;
              return (
                <Text key={m}>
                  <Text>{i === modelCursor ? "▸ " : "  "}</Text>
                  <Text
                    bold={isActive}
                    color={isActive ? BRAND_COLOR : undefined}
                  >
                    {isActive ? `*${m}` : ` ${m}`}
                  </Text>
                </Text>
              );
            })
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            Enter = switch, Esc = back, j/k = navigate, n = add, d = remove
          </Text>
        </Box>
      </Box>
    );
  }

  /* ── list mode ──────────────────────────────── */
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={BRAND_COLOR}
      padding={1}
    >
      <Text bold>Select provider:</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.length === 0 ? (
          <Text dimColor>No providers configured</Text>
        ) : (
          rows.map((row, i) => (
            <Text key={row.name}>
              <Text>{i === cursor ? "▸ " : "  "}</Text>
              <Text
                bold={row.isActive}
                color={row.isActive ? BRAND_COLOR : undefined}
              >
                {row.isActive ? `*${row.name}` : ` ${row.name}`}
              </Text>
              <Text>
                {" "}
                [{row.activeModel}] ({row.models.length} models) {row.baseUrl}
              </Text>
            </Text>
          ))
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Enter = switch, Esc = cancel, j/k = navigate, m = models, n = new, d = delete
        </Text>
      </Box>
    </Box>
  );
}
