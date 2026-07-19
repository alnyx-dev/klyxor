import { getActiveProvider, getActiveProviderName, getActiveModel } from "./config.js";
import { LLM_DEFAULTS, LLM_TIMEOUT_MS } from "./constants.js";

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
  const payload = {
    model: getActiveModel(provider),
    messages,
    tools,
    tool_choice: LLM_DEFAULTS.toolChoice,
    temperature: LLM_DEFAULTS.temperature,
    max_tokens: LLM_DEFAULTS.maxTokens,
  };

  try {
    const resp = await fetch(`${provider.base_url}${LLM_DEFAULTS.endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(
        `⚠️  LLM request failed (${getActiveProviderName()}): ${resp.status} ${text}`
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
    };

    const msg = json.choices[0]?.message;
    if (!msg) return { content: null, tool_calls: [] };

    const content = (msg.content || "").trim();
    const tool_calls = msg.tool_calls || [];
    return { content, tool_calls };
  } catch (e) {
    console.error(
      `⚠️  LLM request failed (${getActiveProviderName()}): ${e}`
    );
    return { content: null, tool_calls: [] };
  }
}
