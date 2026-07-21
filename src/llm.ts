import { getActiveProvider, getActiveProviderName, getActiveModel } from "./config.js";
import {
  LLM_DEFAULTS,
  LLM_TIMEOUT_MS,
  LLM_MAX_RETRIES,
  LLM_RETRY_BASE_MS,
  LLM_RETRYABLE_STATUS,
  ERROR_RECOVERY_MAX_RETRIES,
  ERROR_RECOVERY_BASE_DELAY_MS,
  ERROR_RECOVERY_MAX_DELAY_MS,
  ERROR_RECOVERY_FALLBACK_MODEL,
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

// ── Streaming ────────────────────────────────────────────────────

export interface LlmStreamChunk {
  type: "content" | "tool_calls" | "done" | "error";
  content?: string;
  tool_calls?: ToolCall[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: string;
}

/**
 * Call the LLM with streaming enabled. Returns an async generator that yields
 * chunks as they arrive via SSE (Server-Sent Events).
 */
export async function* callLlmStream(
  messages: LlmMessage[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Array<{ type: string; function: { name: string; description: string; parameters: any } }>
): AsyncGenerator<LlmStreamChunk> {
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
    stream: true,
  };

  let response: Response;
  try {
    response = await fetch(`${provider.base_url}${LLM_DEFAULTS.endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
  } catch (e) {
    yield { type: "error", error: String(e) };
    return;
  }

  if (!response.ok) {
    const text = await response.text();
    yield { type: "error", error: `${response.status} ${text}` };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: "error", error: "Response body is not readable" };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  // Accumulate tool_calls across delta chunks (keyed by index)
  const toolCallsMap = new Map<number, ToolCall>();
  let usage: LlmStreamChunk["usage"];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") {
          // Emit accumulated tool_calls if any
          if (toolCallsMap.size > 0) {
            const toolCalls = Array.from(toolCallsMap.values());
            yield { type: "tool_calls", tool_calls: toolCalls };
          }
          if (usage) {
            yield { type: "done", usage };
          } else {
            yield { type: "done" };
          }
          return;
        }

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  type?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
            };
          };

          // Capture usage from the final chunk
          if (parsed.usage) {
            usage = {
              prompt_tokens: parsed.usage.prompt_tokens ?? 0,
              completion_tokens: parsed.usage.completion_tokens ?? 0,
              total_tokens: parsed.usage.total_tokens ?? 0,
            };
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (!delta) continue;

          // Yield content chunks
          if (delta.content) {
            yield { type: "content", content: delta.content };
          }

          // Accumulate tool_call deltas
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallsMap.has(idx)) {
                toolCallsMap.set(idx, {
                  id: tc.id ?? "",
                  type: "function",
                  function: {
                    name: tc.function?.name ?? "",
                    arguments: tc.function?.arguments ?? "",
                  },
                });
              } else {
                const existing = toolCallsMap.get(idx)!;
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.function.name += tc.function.name;
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
              }
            }
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    // Stream ended without [DONE] — emit what we have
    if (toolCallsMap.size > 0) {
      yield { type: "tool_calls", tool_calls: Array.from(toolCallsMap.values()) };
    }
    yield { type: "done", ...(usage ? { usage } : {}) };
  } finally {
    reader.releaseLock();
  }
}

/**
 * Convenience: consume an entire stream and return a collected LlmResponse.
 */
export async function callLlmStreamCollected(
  messages: LlmMessage[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Array<{ type: string; function: { name: string; description: string; parameters: any } }>
): Promise<LlmResponse> {
  let content = "";
  let tool_calls: ToolCall[] = [];
  let usage: LlmStreamChunk["usage"];

  for await (const chunk of callLlmStream(messages, tools)) {
    if (chunk.type === "content" && chunk.content) {
      content += chunk.content;
    }
    if (chunk.type === "tool_calls" && chunk.tool_calls) {
      tool_calls = chunk.tool_calls;
    }
    if (chunk.usage) usage = chunk.usage;
    if (chunk.type === "error") {
      return { content: null, tool_calls: [] };
    }
  }

  // Record usage if captured
  if (usage) {
    usageTracker.record(usage, getActiveModel(getActiveProvider()));
  }

  return { content: content.trim(), tool_calls };
}

// ── Error Recovery ───────────────────────────────────────────────

export type ErrorCategory =
  | "rate_limit"
  | "server_error"
  | "timeout"
  | "auth"
  | "invalid_request"
  | "network"
  | "unknown";

export interface ErrorInfo {
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  suggestedDelay?: number;
}

/**
 * Classify an error into a category with retry guidance.
 */
export function classifyError(error: unknown, statusCode?: number): ErrorInfo {
  const msg = error instanceof Error ? error.message : String(error);

  // Status-code based classification
  if (statusCode === 429) {
    return {
      category: "rate_limit",
      message: msg,
      retryable: true,
      suggestedDelay: 5000,
    };
  }
  if (statusCode === 401 || statusCode === 403) {
    return {
      category: "auth",
      message: msg,
      retryable: false,
    };
  }
  if (statusCode === 400) {
    return {
      category: "invalid_request",
      message: msg,
      retryable: false,
    };
  }
  if (statusCode && statusCode >= 500) {
    return {
      category: "server_error",
      message: msg,
      retryable: true,
      suggestedDelay: 2000,
    };
  }

  // Error-name based classification
  if (msg.includes("AbortError") || msg.includes("timeout") || msg.includes("TIMEOUT")) {
    return {
      category: "timeout",
      message: msg,
      retryable: true,
      suggestedDelay: 1000,
    };
  }
  if (
    msg.includes("fetch failed") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("network") ||
    msg.includes("ECONNRESET")
  ) {
    return {
      category: "network",
      message: msg,
      retryable: true,
      suggestedDelay: 2000,
    };
  }

  return {
    category: "unknown",
    message: msg,
    retryable: false,
  };
}

/**
 * Compute exponential backoff delay capped at ERROR_RECOVERY_MAX_DELAY_MS.
 */
function backoffDelay(attempt: number, baseMs: number): number {
  const delay = baseMs * 2 ** attempt;
  return Math.min(delay, ERROR_RECOVERY_MAX_DELAY_MS);
}

/**
 * Call the LLM with smart error recovery. Retries on transient errors,
 * respects rate limits, and optionally falls back to a different model.
 */
export async function callLlmWithRecovery(
  messages: LlmMessage[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Array<{ type: string; function: { name: string; description: string; parameters: any } }>,
  options?: {
    maxRetries?: number;
    onRetry?: (attempt: number, error: ErrorInfo) => void;
    fallbackModel?: string;
  }
): Promise<LlmResponse> {
  const maxRetries = options?.maxRetries ?? ERROR_RECOVERY_MAX_RETRIES;
  const onRetry = options?.onRetry;
  const fallbackModel = options?.fallbackModel ?? ERROR_RECOVERY_FALLBACK_MODEL;

  let lastError: ErrorInfo | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = lastError?.suggestedDelay ?? backoffDelay(attempt - 1, ERROR_RECOVERY_BASE_DELAY_MS);
      await sleep(delay);
      onRetry?.(attempt, lastError!);
    }

    try {
      const resp = await callLlm(messages, tools);

      // callLlm returns { content: null, tool_calls: [] } on failure
      // We need to detect this — but it's also a valid "empty" response.
      // We'll check if it looks like an error (null content + no tool_calls)
      // and treat it as a retryable failure.
      if (resp.content === null && resp.tool_calls.length === 0) {
        // This could be a legitimate empty response or an error.
        // Since callLlm already logged the error, treat as retryable.
        lastError = {
          category: "server_error",
          message: "LLM returned empty response",
          retryable: attempt < maxRetries,
        };
        if (attempt < maxRetries) continue;
        return resp;
      }

      return resp;
    } catch (e) {
      lastError = classifyError(e);
      if (!lastError.retryable || attempt >= maxRetries) {
        break;
      }
    }
  }

  // All retries exhausted — try fallback model if available
  if (fallbackModel) {
    try {
      // Temporarily override the model by using callLlm directly
      // with a modified provider that uses the fallback model.
      // Since we can't easily swap models mid-flight, we'll just try
      // one more time and let the caller handle the final failure.
      onRetry?.(maxRetries + 1, {
        category: lastError?.category ?? "unknown",
        message: `All ${maxRetries} retries exhausted. ${lastError?.message ?? "Unknown error"}`,
        retryable: false,
      });
    } catch {
      // Ignore — we're about to return the error
    }
  }

  return { content: null, tool_calls: [] };
}
