import { test, expect, describe } from "bun:test";
import {
  buildSystemPrompt,
  DEFAULT_DIFF_CHAR_BUDGET,
  generateCommitMessage,
  LlmError,
  truncateDiff,
} from "@worktreeos/core/llm";
import type { AiProviderConfig } from "@worktreeos/core/global-config";

interface Capture {
  url: string;
  init: RequestInit;
  bodyJson: any;
}

function recordingFetch(
  response: Response,
  capture: Capture[],
): typeof fetch {
  return (async (url: any, init: any) => {
    capture.push({
      url: String(url),
      init,
      bodyJson: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return response;
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const anthropicProvider: AiProviderConfig = {
  type: "anthropic",
  apiKey: "sk-ant",
  name: "work-anthropic",
  models: ["claude-opus-4-8"],
};

const openaiProvider: AiProviderConfig = {
  type: "openai",
  apiKey: "sk-oai",
  name: "work-openai",
  models: ["gpt-4o"],
};

describe("truncateDiff", () => {
  test("leaves small diffs untouched", () => {
    expect(truncateDiff("abc", 10)).toBe("abc");
  });
  test("truncates and marks oversized diffs", () => {
    const out = truncateDiff("x".repeat(100), 10);
    expect(out.startsWith("x".repeat(10))).toBe(true);
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(100);
  });
});

describe("buildSystemPrompt", () => {
  test("includes language and rules when present", () => {
    const prompt = buildSystemPrompt("- Conventional Commits.", "en");
    expect(prompt).toContain("Write the message in en.");
    expect(prompt).toContain("Conventional Commits");
  });
});

describe("generateCommitMessage wire shapes", () => {
  test("anthropic Messages shape", async () => {
    const capture: Capture[] = [];
    const fetchImpl = recordingFetch(
      jsonResponse({ content: [{ type: "text", text: "feat: add thing" }] }),
      capture,
    );
    const msg = await generateCommitMessage({
      provider: anthropicProvider,
      diff: "diff --git a b",
      rules: "- Conventional Commits.",
      language: "en",
      fetchImpl,
    });
    expect(msg).toBe("feat: add thing");
    expect(capture[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = capture[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant");
    expect(headers["anthropic-version"]).toBeDefined();
    expect(capture[0]!.bodyJson.model).toBe("claude-opus-4-8");
    expect(capture[0]!.bodyJson.system).toContain("Conventional Commits");
    expect(capture[0]!.bodyJson.messages[0].role).toBe("user");
  });

  test("openai Chat Completions shape", async () => {
    const capture: Capture[] = [];
    const fetchImpl = recordingFetch(
      jsonResponse({ choices: [{ message: { content: "fix: bug" } }] }),
      capture,
    );
    const msg = await generateCommitMessage({
      provider: openaiProvider,
      diff: "diff",
      fetchImpl,
    });
    expect(msg).toBe("fix: bug");
    expect(capture[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = capture[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-oai");
    expect(capture[0]!.bodyJson.messages[0].role).toBe("system");
    expect(capture[0]!.bodyJson.messages[1].role).toBe("user");
  });

  test("openrouter uses its default base and the openai shape", async () => {
    const capture: Capture[] = [];
    const fetchImpl = recordingFetch(
      jsonResponse({ choices: [{ message: { content: "chore: x" } }] }),
      capture,
    );
    await generateCommitMessage({
      provider: { type: "openrouter", apiKey: "k", models: ["m"] },
      diff: "d",
      fetchImpl,
    });
    expect(capture[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  test("openai-like uses the configured baseUrl", async () => {
    const capture: Capture[] = [];
    const fetchImpl = recordingFetch(
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
      capture,
    );
    await generateCommitMessage({
      provider: {
        type: "openai-like",
        apiKey: "k",
        baseUrl: "http://localhost:1234/v1/",
        models: ["local"],
      },
      diff: "d",
      fetchImpl,
    });
    expect(capture[0]!.url).toBe("http://localhost:1234/v1/chat/completions");
  });

  test("recovers the completion from an SSE-framed response", async () => {
    // Some OpenAI-compatible gateways always answer with `text/event-stream`,
    // emitting the completion object glued to a trailing `data: [DONE]`
    // terminator — which `res.json()` cannot parse.
    const capture: Capture[] = [];
    const body =
      `${JSON.stringify({ choices: [{ message: { content: "feat: sse" } }] })}` +
      "data: [DONE]\n\n";
    const fetchImpl = recordingFetch(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      capture,
    );
    const msg = await generateCommitMessage({
      provider: openaiProvider,
      diff: "d",
      fetchImpl,
    });
    expect(msg).toBe("feat: sse");
  });

  test("recovers the completion from `data: `-prefixed SSE framing", async () => {
    const inner = JSON.stringify({
      choices: [{ message: { content: "fix: framed" } }],
    });
    const fetchImpl = recordingFetch(
      new Response(`data: ${inner}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      [],
    );
    const msg = await generateCommitMessage({
      provider: openaiProvider,
      diff: "d",
      fetchImpl,
    });
    expect(msg).toBe("fix: framed");
  });

  test("truncates the diff before sending", async () => {
    const capture: Capture[] = [];
    const fetchImpl = recordingFetch(
      jsonResponse({ content: [{ type: "text", text: "msg" }] }),
      capture,
    );
    await generateCommitMessage({
      provider: anthropicProvider,
      diff: "y".repeat(DEFAULT_DIFF_CHAR_BUDGET + 5000),
      fetchImpl,
    });
    const sent: string = capture[0]!.bodyJson.messages[0].content;
    expect(sent).toContain("truncated");
    expect(sent.length).toBeLessThan(DEFAULT_DIFF_CHAR_BUDGET + 5000);
  });
});

describe("generateCommitMessage error mapping", () => {
  test("missing api key", async () => {
    await expect(
      generateCommitMessage({
        provider: { ...anthropicProvider, apiKey: "" },
        diff: "d",
        fetchImpl: recordingFetch(jsonResponse({}), []),
      }),
    ).rejects.toMatchObject({ code: "missing-api-key" });
  });

  test("missing model", async () => {
    await expect(
      generateCommitMessage({
        provider: { type: "openai", apiKey: "k" },
        diff: "d",
        fetchImpl: recordingFetch(jsonResponse({}), []),
      }),
    ).rejects.toMatchObject({ code: "missing-model" });
  });

  test("missing base url for *-like provider", async () => {
    await expect(
      generateCommitMessage({
        provider: { type: "anthropic-like", apiKey: "k", models: ["m"] },
        diff: "d",
        fetchImpl: recordingFetch(jsonResponse({}), []),
      }),
    ).rejects.toMatchObject({ code: "missing-base-url" });
  });

  test("http error preserves status", async () => {
    const err = await generateCommitMessage({
      provider: openaiProvider,
      diff: "d",
      fetchImpl: recordingFetch(
        new Response("rate limited", { status: 429 }),
        [],
      ),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe("http-error");
    expect(err.status).toBe(429);
    expect(err.message).toContain("rate limited");
  });

  test("empty completion", async () => {
    await expect(
      generateCommitMessage({
        provider: openaiProvider,
        diff: "d",
        fetchImpl: recordingFetch(
          jsonResponse({ choices: [{ message: { content: "  " } }] }),
          [],
        ),
      }),
    ).rejects.toMatchObject({ code: "empty-completion" });
  });

  test("network error", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      generateCommitMessage({ provider: openaiProvider, diff: "d", fetchImpl }),
    ).rejects.toMatchObject({ code: "network-error" });
  });
});
