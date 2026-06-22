import type { AiProviderConfig, AiProviderType } from "./global-config";

/**
 * Minimal, provider-agnostic chat client used to generate commit messages from
 * a staged diff. Targets the two documented wire shapes:
 *   - Anthropic Messages API  (`anthropic` / `anthropic-like`)
 *   - OpenAI Chat Completions (`openai` / `openrouter` / `openai-like`)
 *
 * A single non-streaming request with a bounded timeout. No new dependency —
 * uses `fetch`. Keys stay in the existing `aiProviders` config; nothing is
 * persisted here.
 */

export type LlmErrorCode =
  | "missing-api-key"
  | "missing-model"
  | "missing-base-url"
  | "http-error"
  | "empty-completion"
  | "network-error";

/** Structured error for every failure mode the caller must distinguish. */
export class LlmError extends Error {
  constructor(
    message: string,
    public readonly code: LlmErrorCode,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Default character budget for the staged diff before truncation. */
export const DEFAULT_DIFF_CHAR_BUDGET = 12_000;
/** Default bounded timeout for the single generation request. */
export const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TOKENS = 1024;

export interface GenerateCommitMessageParams {
  /** Resolved provider configuration (type, key, optional baseUrl/models). */
  provider: AiProviderConfig;
  /** Model id; falls back to the provider's first declared model. */
  model?: string;
  /** Staged diff text used as the generation input. */
  diff: string;
  /** Repository commit rules appended to the system prompt. */
  rules?: string;
  /** Output language for the generated message. */
  language?: string;
  /** Caller abort signal, linked with the internal timeout. */
  signal?: AbortSignal;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override the diff character budget. */
  maxDiffChars?: number;
  /** Override the bounded request timeout. */
  timeoutMs?: number;
}

type WireShape = "anthropic" | "openai";

function wireShape(type: AiProviderType): WireShape {
  return type === "anthropic" || type === "anthropic-like"
    ? "anthropic"
    : "openai";
}

function defaultBaseUrl(type: AiProviderType): string | undefined {
  switch (type) {
    case "anthropic":
      return "https://api.anthropic.com";
    case "openai":
      return "https://api.openai.com/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    default:
      // openai-like / anthropic-like require an explicit baseUrl.
      return undefined;
  }
}

/** Truncates the diff to a character budget, appending a marker when cut. */
export function truncateDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  return `${diff.slice(0, maxChars)}\n\n[... diff truncated to fit the generation budget ...]`;
}

export function buildSystemPrompt(rules?: string, language?: string): string {
  const lines = [
    "You write a single Git commit message from a staged diff.",
    "Output only the commit message text — no preamble, no code fences, no explanation.",
  ];
  if (language) lines.push(`Write the message in ${language}.`);
  if (rules && rules.trim().length > 0) {
    lines.push("Follow these repository commit rules:", rules.trim());
  }
  return lines.join("\n");
}

function buildUserPrompt(diff: string): string {
  return `Write a commit message for the following staged diff:\n\n${diff}`;
}

function resolveEndpointBase(provider: AiProviderConfig): string {
  const base = provider.baseUrl ?? defaultBaseUrl(provider.type);
  if (!base) {
    throw new LlmError(
      `provider "${provider.name ?? provider.type}" requires a baseUrl`,
      "missing-base-url",
    );
  }
  return base.replace(/\/+$/, "");
}

function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

/**
 * Generates a commit message for the staged diff using the resolved provider.
 * Returns the message text, or throws `LlmError` (missing key / model / base
 * URL, HTTP failure, empty completion, network error).
 */
export async function generateCommitMessage(
  params: GenerateCommitMessageParams,
): Promise<string> {
  const { provider } = params;
  const doFetch = params.fetchImpl ?? fetch;
  const apiKey = provider.apiKey;
  if (!apiKey || apiKey.length === 0) {
    throw new LlmError(
      `provider "${provider.name ?? provider.type}" has no API key`,
      "missing-api-key",
    );
  }
  const model = params.model ?? provider.models?.[0];
  if (!model) {
    throw new LlmError(
      `no model configured for provider "${provider.name ?? provider.type}"`,
      "missing-model",
    );
  }
  const base = resolveEndpointBase(provider);
  const shape = wireShape(provider.type);
  const diff = truncateDiff(
    params.diff,
    params.maxDiffChars ?? DEFAULT_DIFF_CHAR_BUDGET,
  );
  const system = buildSystemPrompt(params.rules, params.language);
  const user = buildUserPrompt(diff);
  const signal = combineSignals(params.signal, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let url: string;
  let headers: Record<string, string>;
  let body: string;
  if (shape === "anthropic") {
    url = `${base}/v1/messages`;
    headers = {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
    body = JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    });
  } else {
    url = `${base}/chat/completions`;
    headers = {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    };
    body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
  }

  let res: Response;
  try {
    res = await doFetch(url, { method: "POST", headers, body, signal });
  } catch (e) {
    throw new LlmError(
      `request to ${provider.name ?? provider.type} failed: ${(e as Error).message}`,
      "network-error",
    );
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).trim();
    } catch {
      /* ignore body read failure */
    }
    throw new LlmError(
      `provider request failed (${res.status})${detail ? `: ${detail}` : ""}`,
      "http-error",
      res.status,
    );
  }

  const bodyText = await res.text();
  const data = parseResponseBody(bodyText);
  if (data === undefined) {
    throw new LlmError(
      "provider returned an unparseable response",
      "http-error",
      res.status,
    );
  }
  const text = extractCompletion(shape, data);
  if (!text || text.trim().length === 0) {
    throw new LlmError("provider returned an empty completion", "empty-completion");
  }
  return text.trim();
}

function extractCompletion(shape: WireShape, data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if (shape === "anthropic") {
    const content = (data as { content?: unknown }).content;
    if (!Array.isArray(content)) return undefined;
    const parts: string[] = [];
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.length > 0 ? parts.join("") : undefined;
  }
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

/**
 * Parse a provider response body into the completion JSON. Well-behaved
 * providers return a single JSON document, but some OpenAI-compatible gateways
 * always answer with `text/event-stream` — even when streaming was not
 * requested — emitting the completion object followed by a `data: [DONE]`
 * terminator (and sometimes wrapping the payload in `data: ` lines). When a
 * direct parse fails, fall back to extracting the first complete JSON object
 * from the body. Returns `undefined` when no JSON object can be recovered.
 */
export function parseResponseBody(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return extractFirstJsonObject(trimmed);
  }
}

/**
 * Extract and parse the first brace-balanced JSON object embedded in `text`,
 * ignoring any surrounding SSE framing (`data: ` prefixes, a trailing
 * `data: [DONE]`). String-literal aware so braces inside values do not confuse
 * the depth counter. Sufficient for non-streaming requests, where the body
 * carries a single completion object.
 */
function extractFirstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
