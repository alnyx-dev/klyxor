import type { LlmMessage } from "./llm.js";
import { callLlm } from "./llm.js";
import {
  COMPACT_THRESHOLD_MESSAGES,
  COMPACT_KEEP_RECENT,
} from "./constants.js";

/**
 * Whether a message list is large enough to warrant compaction.
 */
export function shouldCompact(messages: LlmMessage[]): boolean {
  return messages.length > COMPACT_THRESHOLD_MESSAGES;
}

/**
 * Render a message into a plain-text transcript line for summarization.
 */
function renderForSummary(m: LlmMessage): string {
  if (m.role === "tool") {
    const body = (m.content ?? "").slice(0, 600);
    return `[tool result]\n${body}`;
  }
  if (m.role === "assistant") {
    const calls =
      m.tool_calls && m.tool_calls.length > 0
        ? " " +
          m.tool_calls
            .map((tc) => `<call ${tc.function.name}(${tc.function.arguments})>`)
            .join(" ")
        : "";
    return `[assistant] ${(m.content ?? "").slice(0, 800)}${calls}`;
  }
  return `[${m.role}] ${(m.content ?? "").slice(0, 800)}`;
}

/**
 * Pick a safe cut point so the retained tail never begins with a `tool`
 * message that has lost its preceding assistant tool_calls. We keep at least
 * COMPACT_KEEP_RECENT recent messages, then walk the boundary forward until it
 * lands on a non-tool message (a fresh user/assistant turn boundary).
 */
function safeTailStart(messages: LlmMessage[], firstBodyIndex: number): number {
  let cut = Math.max(firstBodyIndex, messages.length - COMPACT_KEEP_RECENT);
  while (cut < messages.length && messages[cut]!.role === "tool") {
    cut++;
  }
  return cut;
}

/**
 * Compact a long conversation: keep the leading system message(s), replace the
 * middle with a single summary message produced by the LLM, and keep the most
 * recent turns verbatim. Preserves tool_call/tool_call_id pairing integrity.
 *
 * Returns the original array unchanged if compaction is not warranted or if the
 * summarization call fails (fail-safe: never lose context).
 */
export async function compactMessages(
  messages: LlmMessage[]
): Promise<LlmMessage[]> {
  if (!shouldCompact(messages)) return messages;

  // Preserve all leading system messages verbatim.
  let firstBodyIndex = 0;
  while (
    firstBodyIndex < messages.length &&
    messages[firstBodyIndex]!.role === "system"
  ) {
    firstBodyIndex++;
  }

  const head = messages.slice(0, firstBodyIndex);
  const tailStart = safeTailStart(messages, firstBodyIndex);
  const middle = messages.slice(firstBodyIndex, tailStart);
  const tail = messages.slice(tailStart);

  // Nothing meaningful to summarize.
  if (middle.length === 0) return messages;

  const transcript = middle.map(renderForSummary).join("\n");
  const summaryPrompt: LlmMessage[] = [
    {
      role: "system",
      content:
        "You compress a coding-agent conversation into a dense technical summary. " +
        "Preserve: user goals, decisions made, files created/edited (with paths), " +
        "commands run and their outcomes, key findings, and any unresolved TODOs. " +
        "Be terse and information-dense. Output only the summary text.",
    },
    {
      role: "user",
      content: `Summarize this conversation segment:\n\n${transcript}`,
    },
  ];

  const resp = await callLlm(summaryPrompt, []);
  if (!resp.content) {
    // Summarization failed — keep the original context rather than dropping it.
    return messages;
  }

  const summaryMessage: LlmMessage = {
    role: "system",
    content:
      "[System: compressed context]\n" +
      resp.content +
      "\n[End compressed section — recent messages follow]",
  };

  return [...head, summaryMessage, ...tail];
}
