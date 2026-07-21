import { callLlm, callLlmStream, callLlmWithRecovery, type LlmMessage } from "./llm.js";
import { buildTools, type Tool, type LogFn, type TaskProvider, type ToolLogEvent } from "./tools.js";
import { makeListSkillsTool, makeReadSkillTool, makeFindSkillsTool } from "./skills.js";
import { DEFAULT_MAX_TURNS, SEPARATOR_WIDTH, PREVIEW, DEFAULT_MODE, DEFAULT_STREAM_ENABLED } from "./constants.js";
import { mcpManager } from "./mcp.js";

export type { LogFn } from "./tools.js";

/** Re-export SubagentPool for consumers that need direct access. */
export { SubagentPool, type PoolTask, type PoolResult, type PoolTaskResult } from "./subagent-pool.js";
export { MAX_PARALLEL_AGENTS } from "./constants.js";

export const PLAN_SYSTEM_PROMPT = `\
You are Klyxor, a coding agent operating in PLAN mode.

Your job is to investigate and produce a plan, NOT to make changes. Read code, run \
read-only commands, check for skills, and think through the approach. Commands that \
look like they modify the filesystem or state will be blocked.

Finish with a clear, numbered, actionable plan: what should change, in what order, \
and any risks or open questions. Do not claim to have made changes — you haven't.`;

export const BUILD_SYSTEM_PROMPT = `\
You are Klyxor, a coding agent operating in BUILD mode.

You have full access to execute commands and make changes. If the task is complex \
or has independent sub-parts, consider delegating pieces to subagents via \`delegate\` \
to keep your own context focused — but don't over-delegate trivial work.

Check \`list_skills\` early if the task might match a known workflow (file formats, \
frameworks, deployment steps, etc.) and \`read_skill\` to load relevant instructions \
before proceeding.

Be concise. Explain what you're doing before each command. Finish with a plain-text \
summary of what was actually done (no tool call) — that summary is what gets returned \
to whoever asked for this task, including a parent agent if you were delegated to, or \
a user in a chat session.`;

export const MODE_PROMPTS: Record<string, string> = {
  plan: PLAN_SYSTEM_PROMPT,
  build: BUILD_SYSTEM_PROMPT,
};

export function buildToolsForAgent(
  mode: string,
  depth: number,
  log: LogFn,
  taskProvider?: TaskProvider
): Map<string, Tool> {
  const tools = buildTools(mode, depth, log, runAgent, taskProvider, mcpManager);
  tools.set("list_skills", makeListSkillsTool());
  tools.set("read_skill", makeReadSkillTool());
  tools.set("find_skills", makeFindSkillsTool());
  return tools;
}

/**
 * Run the tool-calling loop on `messages` until the model gives a final
 * text answer. Mutates `messages` in place (appends assistant/tool entries)
 * and returns the final answer text.
 */
export async function agentTurn(
  messages: LlmMessage[],
  tools: Map<string, Tool>,
  log: LogFn = console.log,
  maxTurns?: number,
  verbose: boolean = true,
  options?: { stream?: boolean }
): Promise<string> {
  const limit = maxTurns ?? DEFAULT_MAX_TURNS;
  const useStream = options?.stream ?? DEFAULT_STREAM_ENABLED;

  for (let turn = 1; turn <= limit; turn++) {
    if (verbose) {
      log(`\n${"=".repeat(SEPARATOR_WIDTH)}\n🔄 turn ${turn}\n${"=".repeat(SEPARATOR_WIDTH)}`);
    }

    const toolSchemas = Array.from(tools.values()).map((t) => t.schema());

    let content: string | null;
    let toolCalls: import("./llm.js").ToolCall[];

    if (useStream) {
      // Streaming mode: yield chunks as they arrive
      let streamedContent = "";
      let streamedToolCalls: import("./llm.js").ToolCall[] = [];
      let hasError = false;
      const MAX_STREAM_CONTENT_CHARS = 500_000;

      for await (const chunk of callLlmStream(messages, toolSchemas)) {
        if (chunk.type === "content" && chunk.content) {
          streamedContent += chunk.content;
          if (streamedContent.length > MAX_STREAM_CONTENT_CHARS) {
            streamedContent = streamedContent.slice(0, MAX_STREAM_CONTENT_CHARS) + "\n... [stream truncated]";
          }
          // Write directly to stdout for real-time display
          if (verbose) process.stdout.write(chunk.content);
        }
        if (chunk.type === "tool_calls" && chunk.tool_calls) {
          streamedToolCalls = chunk.tool_calls;
        }
        if (chunk.type === "error") {
          hasError = true;
          log(`❌ Streaming error: ${chunk.error}`);
        }
      }

      if (hasError) {
        // Fall back to non-streaming with error recovery
        const result = await callLlmWithRecovery(messages, toolSchemas, {
          onRetry: (attempt, err) => log(`⚠️ Retry ${attempt}: ${err.message}`),
        });
        content = result.content;
        toolCalls = result.tool_calls;
      } else {
        content = streamedContent.trim() || null;
        toolCalls = streamedToolCalls;
      }

      // Add newline after streamed content
      if (verbose && streamedContent) process.stdout.write("\n");
    } else {
      // Non-streaming mode: use error recovery
      const result = await callLlmWithRecovery(messages, toolSchemas, {
        onRetry: (attempt, err) => log(`⚠️ Retry ${attempt}: ${err.message}`),
      });
      content = result.content;
      toolCalls = result.tool_calls;
    }

    if (content === null && toolCalls.length === 0) {
      log("❌ LLM call failed.");
      return "[Error: LLM call failed]";
    }

    if (verbose && content) {
      if (!useStream) {
        log(`🤖 ${content}`);
      }
    }

    if (toolCalls.length === 0) {
      if (verbose) log("✅ finished");
      return content || "(empty response)";
    }

    const assistantMsg: LlmMessage = {
      role: "assistant",
      content: content || null,
      tool_calls: toolCalls,
    };
    messages.push(assistantMsg);

    for (const tc of toolCalls) {
      const fname = tc.function.name;
      const tcId = tc.id;
      let resultStr: string;

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        resultStr = `Error: invalid JSON arguments for tool '${fname}': ${msg}`;
        messages.push({
          role: "tool",
          content: resultStr,
          tool_call_id: tcId,
        });
        continue;
      }

      const tool = tools.get(fname);
      if (!tool) {
        resultStr = `Error: unknown tool '${fname}'`;
      } else {
        if (verbose) {
          const argsPreview = JSON.stringify(args).slice(0, PREVIEW.args);
          log({ type: "tool_call", tool: fname, args: argsPreview });
        }
        try {
          const MAX_TOOL_RESULT_CHARS = 50_000;
          resultStr = String(await tool.call(args));
          if (resultStr.length > MAX_TOOL_RESULT_CHARS) {
            resultStr = resultStr.slice(0, MAX_TOOL_RESULT_CHARS) + "\n... [truncated, full result too large]";
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          resultStr = `Error calling ${fname}: ${msg}`;
        }
      }

      if (verbose) {
        const preview =
          resultStr.length > PREVIEW.result
            ? resultStr.slice(0, PREVIEW.result) + "..."
            : resultStr;
        log({ type: "tool_result", tool: fname, result: preview });
      }
      messages.push({
        role: "tool",
        tool_call_id: tcId,
        content: resultStr,
      });
    }
  }

  if (verbose) log(`⚠️  Max turns (${limit}) reached.`);
  return `[Error: hit max turns (${limit}) without a final answer]`;
}

/**
 * Stateless one-shot run: fresh [system, user] history, returns the
 * final answer. Used by the CLI one-shot mode and by `delegate`.
 */
export async function runAgent(
  task: string,
  mode: string = DEFAULT_MODE,
  depth: number = 0,
  log: LogFn = console.log,
  maxTurns?: number
): Promise<string> {
  const indent = "  ".repeat(depth);

  const _log: LogFn = (msg) => {
    if (typeof msg === "string") {
      log(`${indent}${msg}`);
    } else {
      log(msg);
    }
  };

  const tools = buildToolsForAgent(mode, depth, _log);
  const messages: LlmMessage[] = [
    { role: "system", content: MODE_PROMPTS[mode] || BUILD_SYSTEM_PROMPT },
    { role: "user", content: task },
  ];
  return agentTurn(messages, tools, _log, maxTurns, true);
}
