import { env } from "./env";

/**
 * Minimal OpenRouter client.
 *
 * Deliberately a plain fetch wrapper rather than an SDK: the surface we need is
 * one endpoint, and an SDK would add a dependency whose version churn we cannot
 * debug in this workflow.
 *
 * Handles the three failures that actually occur in practice:
 *   402 — no credits. Fatal, and worth naming explicitly.
 *   429 — rate limited. Retried with backoff; the common case on free tiers.
 *   5xx — provider hiccup. Retried.
 */

const BASE = "https://openrouter.ai/api/v1";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: unknown[];
  model?: string;
  temperature?: number;
  timeoutMs?: number;
}

export interface ChatResponse {
  message: ChatMessage;
  finishReason: string;
  model: string;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fatal: boolean
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function chatCompletion(
  req: ChatRequest,
  attempts = 4
): Promise<ChatResponse> {
  if (!env.OPENROUTER_API_KEY) {
    throw new OpenRouterError("OPENROUTER_API_KEY is not set.", 0, true);
  }

  const model = req.model ?? env.OPENROUTER_MODEL;
  const timeoutMs = req.timeoutMs ?? 90_000;

  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          // Optional attribution headers OpenRouter uses for its rankings.
          "X-Title": "AI Purchasing Agent",
        },
        body: JSON.stringify({
          model,
          messages: req.messages,
          ...(req.tools ? { tools: req.tools, tool_choice: "auto" } : {}),
          temperature: req.temperature ?? 0,
        }),
        signal: controller.signal,
      });

      if (res.status === 402) {
        throw new OpenRouterError(
          "OpenRouter returned 402: the account has no credits for this model. " +
            "Switch OPENROUTER_MODEL to a free model or add credits.",
          402,
          true
        );
      }

      if (res.status === 429 || res.status >= 500) {
        const body = await res.text();
        lastError = new OpenRouterError(
          `OpenRouter returned ${res.status}: ${body.slice(0, 300)}`,
          res.status,
          false
        );
        // Free tiers rate-limit hard, so back off generously.
        if (attempt < attempts - 1) {
          await sleep(2000 * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }

      if (!res.ok) {
        throw new OpenRouterError(
          `OpenRouter returned ${res.status}: ${(await res.text()).slice(0, 300)}`,
          res.status,
          true
        );
      }

      const data = await res.json();

      // OpenRouter surfaces upstream provider errors inside a 200 response.
      if (data.error) {
        throw new OpenRouterError(
          `Provider error: ${JSON.stringify(data.error).slice(0, 300)}`,
          200,
          true
        );
      }

      const choice = data.choices?.[0];
      if (!choice) {
        throw new OpenRouterError(
          `Response contained no choices: ${JSON.stringify(data).slice(0, 300)}`,
          200,
          true
        );
      }

      return {
        message: choice.message as ChatMessage,
        finishReason: choice.finish_reason ?? "unknown",
        model: data.model ?? model,
        usage: data.usage ?? null,
      };
    } catch (err) {
      clearTimeout(timer);

      if (err instanceof OpenRouterError && err.fatal) throw err;

      lastError = err;
      if (attempt < attempts - 1) {
        await sleep(2000 * Math.pow(2, attempt));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}