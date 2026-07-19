import { getActiveModel, getActiveProviderName } from "./config.js";

/**
 * Token usage + cost tracking.
 *
 * OpenAI-compatible /chat/completions responses include a `usage` object with
 * prompt_tokens / completion_tokens / total_tokens. We accumulate these per
 * model and estimate cost from a small built-in price table (USD per 1M tokens).
 * Prices are best-effort defaults; unknown models fall back to a generic rate.
 */

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ModelUsage {
  model: string;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/** USD per 1,000,000 tokens: [prompt, completion]. */
interface Price {
  prompt: number;
  completion: number;
}

const PRICE_TABLE: Record<string, Price> = {
  "gpt-4o": { prompt: 2.5, completion: 10 },
  "gpt-4o-mini": { prompt: 0.15, completion: 0.6 },
  "gpt-4.1": { prompt: 2, completion: 8 },
  "gpt-4.1-mini": { prompt: 0.4, completion: 1.6 },
  "o1": { prompt: 15, completion: 60 },
  "o3-mini": { prompt: 1.1, completion: 4.4 },
  "claude-3-5-sonnet": { prompt: 3, completion: 15 },
  "claude-3-5-haiku": { prompt: 0.8, completion: 4 },
  "claude-sonnet-4": { prompt: 3, completion: 15 },
  "claude-opus-4": { prompt: 15, completion: 75 },
};

/** Generic fallback when the model is not in the price table. */
const DEFAULT_PRICE: Price = { prompt: 1, completion: 3 };

function priceFor(model: string): Price {
  if (PRICE_TABLE[model]) return PRICE_TABLE[model];
  // Prefix match: "gpt-4o-2024-08-06" → "gpt-4o".
  const key = Object.keys(PRICE_TABLE).find((k) => model.startsWith(k));
  return key ? PRICE_TABLE[key] : DEFAULT_PRICE;
}

class UsageTracker {
  private byModel = new Map<string, ModelUsage>();

  record(usage: Partial<TokenUsage> | undefined, model?: string): void {
    if (!usage) return;
    const m = model || getActiveModel() || "unknown";
    const entry = this.byModel.get(m) || {
      model: m,
      calls: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
    };
    entry.calls += 1;
    entry.prompt_tokens += usage.prompt_tokens || 0;
    entry.completion_tokens += usage.completion_tokens || 0;
    this.byModel.set(m, entry);
  }

  totals(): { calls: number; prompt: number; completion: number; total: number } {
    let calls = 0;
    let prompt = 0;
    let completion = 0;
    for (const e of this.byModel.values()) {
      calls += e.calls;
      prompt += e.prompt_tokens;
      completion += e.completion_tokens;
    }
    return { calls, prompt, completion, total: prompt + completion };
  }

  estimateCostUsd(): number {
    let cost = 0;
    for (const e of this.byModel.values()) {
      const p = priceFor(e.model);
      cost += (e.prompt_tokens / 1_000_000) * p.prompt;
      cost += (e.completion_tokens / 1_000_000) * p.completion;
    }
    return cost;
  }

  reset(): void {
    this.byModel.clear();
  }

  /** Human-readable summary for /cost and /tokens commands. */
  report(): string {
    const t = this.totals();
    if (t.calls === 0) return "No LLM usage recorded yet this session.";
    const lines: string[] = [];
    lines.push(
      `Provider: ${getActiveProviderName()}  |  ${t.calls} call${t.calls === 1 ? "" : "s"}`
    );
    for (const e of this.byModel.values()) {
      const p = priceFor(e.model);
      const c =
        (e.prompt_tokens / 1_000_000) * p.prompt +
        (e.completion_tokens / 1_000_000) * p.completion;
      lines.push(
        `  ${e.model}: ${e.prompt_tokens} in + ${e.completion_tokens} out ` +
          `(${e.calls} call${e.calls === 1 ? "" : "s"}) ≈ $${c.toFixed(4)}`
      );
    }
    lines.push(
      `Total: ${t.prompt} in + ${t.completion} out = ${t.total} tokens ≈ $${this.estimateCostUsd().toFixed(4)}`
    );
    return lines.join("\n");
  }
}

/** Module-level singleton — usage is accumulated for the whole process run. */
export const usageTracker = new UsageTracker();
