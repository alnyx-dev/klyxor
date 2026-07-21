import { getActiveProvider, getActiveProviderName, getActiveModel } from "./config.js";
import {
  LLM_DEFAULTS,
  LLM_TIMEOUT_MS,
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

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/**
 * Call the OpenAI-compatible /chat/completions endpoint (single attempt).
 * Returns { content, tool_calls } on success.
 * Throws on HTTP errors or network failures — callers handle retry/recovery.
 */
export async function callLlm(
  messages: LlmMessage[],
  tools: ToolDefinition[]
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

  const resp = await fetch(`${provider.base_url}${LLM_DEFAULTS.endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM request failed (${getActiveProviderName()}): ${resp.status} ${text}`);
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
  tools: ToolDefinition[]
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

  // Retry the initial fetch once on failure (2 attempts max)
  let response: Response | undefined;
  const maxFetchAttempts = 2;
  for (let attempt = 0; attempt < maxFetchAttempts; attempt++) {
    try {
      const attemptResp = await fetch(`${provider.base_url}${LLM_DEFAULTS.endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      // If OK or last attempt or non-retryable error, accept the response
      if (attemptResp.ok || attempt === maxFetchAttempts - 1 || !LLM_RETRYABLE_STATUS.has(attemptResp.status)) {
        response = attemptResp;
        break;
      }
      // Retryable HTTP error — wait and retry
      await sleep(1000);
    } catch (e) {
      if (attempt === maxFetchAttempts - 1) {
        yield { type: "error", error: String(e) };
        return;
      }
      // Network error — wait and retry
      await sleep(1000);
    }
  }

  if (!response || !response.ok) {
    const text = response ? await response.text() : "No response";
    const status = response?.status ?? 0;
    yield { type: "error", error: `${status} ${text}` };
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
  tools: ToolDefinition[]
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
  tools: ToolDefinition[],
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
      // callLlm now throws on failure, so a successful return means a valid response
      const resp = await callLlm(messages, tools);

      // callLlm returns { content: null, tool_calls: [] } only when the API
      // returns a response with no message — treat as retryable.
      if (resp.content === null && resp.tool_calls.length === 0) {
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
      // callLlm throws on HTTP errors and network failures
      lastError = classifyError(e);
      if (!lastError.retryable || attempt >= maxRetries) {
        break;
      }
    }
  }

  // All retries exhausted — try fallback model if available
  if (fallbackModel) {
    onRetry?.(maxRetries + 1, {
      category: lastError?.category ?? "unknown",
      message: `All ${maxRetries} retries exhausted. Trying fallback model: ${fallbackModel}`,
      retryable: false,
    });

    try {
      const provider = getActiveProvider();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.api_key}`,
      };
      const payload = {
        model: fallbackModel,
        messages,
        tools,
        tool_choice: LLM_DEFAULTS.toolChoice,
        temperature: LLM_DEFAULTS.temperature,
        max_tokens: LLM_DEFAULTS.maxTokens,
      };

      const resp = await fetch(`${provider.base_url}${LLM_DEFAULTS.endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error(
          `⚠️  Fallback model (${fallbackModel}) failed: ${resp.status} ${text}`
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

      usageTracker.record(json.usage, fallbackModel);

      const msg = json.choices[0]?.message;
      if (!msg) return { content: null, tool_calls: [] };

      const content = (msg.content || "").trim();
      const tool_calls = msg.tool_calls || [];
      return { content, tool_calls };
    } catch (e) {
      console.error(
        `⚠️  Fallback model (${fallbackModel}) failed: ${String(e)}`
      );
      return { content: null, tool_calls: [] };
    }
  }

  return { content: null, tool_calls: [] };
}
