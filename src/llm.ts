import { getActiveProvider, getActiveProviderName, getActiveModel } from "./config.js";
import {
  LLM_DEFAULTS,
  LLM_TIMEOUT_MS,
  LLM_MAX_RETRIES,
  LLM_RETRY_BASE_MS,
  LLM_RETRYABLE_STATUS,
} from "./constants.js";
import { usageTracker } from "./usage.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmResponse {
  content: string | null;
  tool_calls: ToolCall[];
}

/**
 * Call the OpenAI-compatible /chat/completions endpoint.
 * Returns { content, tool_calls } on success, or { content: null, tool_calls: [] } on failure.
 */
export async function callLlm(
  messages: LlmMessage[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Array<{ type: string; function: { name: string; description: string; parameters: any } }>
): Promise<LlmResponse> {
  const provider = getActiveProvider();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.api_key}`,
  };
  const model = getActiveModel(provider);
  const payload = {
    model,
    messages,
    tools,
    tool_choice: LLM_DEFAULTS.toolChoice,
    temperature: LLM_DEFAULTS.temperature,
    max_tokens: LLM_DEFAULTS.maxTokens,
  };

  let lastError = "";

  for (let attempt = 0; attempt < LLM_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff before a retry.
      await sleep(LLM_RETRY_BASE_MS * 2 ** (attempt - 1));
    }

    try {
      const resp = await fetch(`${provider.base_url}${LLM_DEFAULTS.endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });

      if (!resp.ok) {
        const text = await resp.text();
        lastError = `${resp.status} ${text}`;
        if (LLM_RETRYABLE_STATUS.has(resp.status) && attempt < LLM_MAX_RETRIES - 1) {
          console.error(
            `⚠️  LLM request failed (${getActiveProviderName()}): ${lastError} — retrying (${attempt + 1}/${LLM_MAX_RETRIES})`
          );
          continue;
        }
        console.error(
          `⚠️  LLM request failed (${getActiveProviderName()}): ${lastError}`
        );
        return { content: null, tool_calls: [] };
      }

      const json = (await resp.json()) as {
        choices: Array<{
          message: {
            content?: string | null;
            tool_calls?: ToolCall[];
          };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      usageTracker.record(json.usage, model);

      const msg = json.choices[0]?.message;
      if (!msg) return { content: null, tool_calls: [] };

      const content = (msg.content || "").trim();
      const tool_calls = msg.tool_calls || [];
      return { content, tool_calls };
    } catch (e) {
      // Network error / timeout — retryable.
      lastError = String(e);
      if (attempt < LLM_MAX_RETRIES - 1) {
        console.error(
          `⚠️  LLM request failed (${getActiveProviderName()}): ${lastError} — retrying (${attempt + 1}/${LLM_MAX_RETRIES})`
        );
        continue;
      }
    }
  }

  console.error(
    `⚠️  LLM request failed (${getActiveProviderName()}): ${lastError}`
  );
  return { content: null, tool_calls: [] };
}
