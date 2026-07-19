import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import {
  getProviders,
  getActiveProviderName,
  addProvider,
  saveConfig,
  removeProvider,
} from "../config.js";

interface ProviderPickerProps {
  onSelect: (name: string) => void;
  onCancel: () => void;
  onAdded?: () => void;
}

interface ProviderRow {
  name: string;
  model: string;
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
      model: p.model,
      baseUrl: p.base_url,
      isActive: name === activeName,
    })
  );

  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<
    "list" | "add" | "confirm-delete"
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
      const msg = addProvider(name, baseUrl, model, apiKey);
      saveConfig();
      setMode("list");
      setAddStep(0);
      setAddValues(["", "", "", ""]);
      if (onAdded) onAdded();
    }
  }, [addStep, addValues, onAdded]);

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
    } else if (mode === "confirm-delete") {
      if (inputStr === "y" && deleteTarget) {
        const msg = removeProvider(deleteTarget);
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

  /* ── add mode ──────────────────────────────── */
  if (mode === "add") {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="#DA7756"
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
                ? "https://api.example.com/v1"
                : addStep === 2
                  ? "sk-..."
                  : addStep === 3
                    ? "gpt-4"
                    : "my-provider"
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
        borderColor="#DA7756"
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

  /* ── list mode ──────────────────────────────── */
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#DA7756"
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
                color={row.isActive ? "#DA7756" : undefined}
              >
                {row.isActive ? `*${row.name}` : ` ${row.name}`}
              </Text>
              <Text>
                {" "}
                [{row.model}] {row.baseUrl}
              </Text>
            </Text>
          ))
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Enter = switch, Esc = cancel, j/k = navigate, n = new, d =
          delete
        </Text>
      </Box>
    </Box>
  );
}
