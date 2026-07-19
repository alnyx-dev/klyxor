import { callLlm, type LlmMessage } from "./llm.js";
import { buildTools, type Tool, type LogFn } from "./tools.js";
import { makeListSkillsTool, makeReadSkillTool } from "./skills.js";

export type { LogFn } from "./tools.js";

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

export const DEFAULT_MAX_TURNS = 200;

export function buildToolsForAgent(
  mode: string,
  depth: number,
  log: LogFn
): Map<string, Tool> {
  const tools = buildTools(mode, depth, log, runAgent);
  tools.set("list_skills", makeListSkillsTool());
  tools.set("read_skill", makeReadSkillTool());
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
  verbose: boolean = true
): Promise<string> {
  const limit = maxTurns ?? DEFAULT_MAX_TURNS;

  for (let turn = 1; turn <= limit; turn++) {
    if (verbose) {
      log(`\n${"=".repeat(50)}\n🔄 turn ${turn}\n${"=".repeat(50)}`);
    }

    const toolSchemas = Array.from(tools.values()).map((t) => t.schema());

    const { content, tool_calls: toolCalls } = await callLlm(
      messages,
      toolSchemas
    );

    if (content === null && toolCalls.length === 0) {
      log("❌ LLM call failed.");
      return "[Error: LLM call failed]";
    }

    if (verbose && content) {
      log(`🤖 ${content}`);
    }

    if (toolCalls.length === 0) {
      log("✅ finished");
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
      } catch (e) {
        resultStr = `Error: invalid JSON arguments for tool '${fname}': ${e}`;
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
          const argsPreview = JSON.stringify(args).slice(0, 200);
          log(`🔧 ${fname}(${argsPreview})`);
        }
        try {
          resultStr = String(await tool.call(args));
        } catch (e) {
          resultStr = `Error calling ${fname}: ${e}`;
        }
      }

      if (verbose) {
        const preview =
          resultStr.length > 400
            ? resultStr.slice(0, 400) + "..."
            : resultStr;
        log(`   → ${preview}`);
      }
      messages.push({
        role: "tool",
        tool_call_id: tcId,
        content: resultStr,
      });
    }
  }

  log(`⚠️  Max turns (${limit}) reached.`);
  return `[Error: hit max turns (${limit}) without a final answer]`;
}

/**
 * Stateless one-shot run: fresh [system, user] history, returns the
 * final answer. Used by the CLI one-shot mode and by `delegate`.
 */
export async function runAgent(
  task: string,
  mode: string = "build",
  depth: number = 0,
  log: LogFn = console.log,
  maxTurns?: number
): Promise<string> {
  const indent = "  ".repeat(depth);

  const _log: LogFn = (msg: string): void => {
    log(`${indent}${msg}`);
  };

  const tools = buildToolsForAgent(mode, depth, _log);
  const messages: LlmMessage[] = [
    { role: "system", content: MODE_PROMPTS[mode] || BUILD_SYSTEM_PROMPT },
    { role: "user", content: task },
  ];
  return agentTurn(messages, tools, _log, maxTurns, true);
}
