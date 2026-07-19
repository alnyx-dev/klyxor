import fs from "node:fs";
import path from "node:path";
import type { LlmMessage } from "./llm.js";
import { KLYXOR_DIR } from "./config.js";

/** Structural type for a session — avoids a circular import with sessions.ts. */
export interface ExportableSession {
  mode: string;
  messages: LlmMessage[];
}

function fmtMessage(m: LlmMessage): string {
  switch (m.role) {
    case "system":
      return `### System\n\n\`\`\`\n${(m.content ?? "").trim()}\n\`\`\``;
    case "user":
      return `### User\n\n${(m.content ?? "").trim()}`;
    case "assistant": {
      const parts: string[] = ["### Assistant"];
      if (m.content && m.content.trim()) parts.push(m.content.trim());
      if (m.tool_calls && m.tool_calls.length > 0) {
        const calls = m.tool_calls
          .map(
            (tc) =>
              `- \`${tc.function.name}\`\n  \`\`\`json\n  ${tc.function.arguments}\n  \`\`\``
          )
          .join("\n");
        parts.push(`**Tool calls:**\n${calls}`);
      }
      return parts.join("\n\n");
    }
    case "tool":
      return `### Tool result\n\n\`\`\`\n${(m.content ?? "").trim()}\n\`\`\``;
    default:
      return `### ${m.role}\n\n${(m.content ?? "").trim()}`;
  }
}

/**
 * Export a chat session to a Markdown transcript file.
 *
 * @param session  The session to export (needs `mode` and `messages`).
 * @param name     A label for the session (used in the header and filename).
 * @param outPath  Optional explicit output path. Defaults to
 *                 `<KLYXOR_DIR>/exports/<name>-<timestamp>.md`.
 * @returns The absolute path of the written file.
 */
export function exportSessionMarkdown(
  session: ExportableSession,
  name: string,
  outPath?: string
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = name.replace(/[^\w.-]+/g, "_") || "session";

  const target =
    outPath ??
    path.join(KLYXOR_DIR, "exports", `${safeName}-${timestamp}.md`);

  fs.mkdirSync(path.dirname(target), { recursive: true });

  const header = [
    `# Klyxor session: ${name}`,
    "",
    `- **Mode:** ${session.mode}`,
    `- **Exported:** ${new Date().toISOString()}`,
    `- **Messages:** ${session.messages.length}`,
    "",
    "---",
    "",
  ].join("\n");

  const body = session.messages.map(fmtMessage).join("\n\n---\n\n");

  fs.writeFileSync(target, header + body + "\n", "utf-8");
  return path.resolve(target);
}
