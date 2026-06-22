import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultLoggingConfig,
  type LoggingConfig,
} from "@worktreeos/core/global-config";
import { createDaemonLogger } from "@worktreeos/daemon/logger";

/** Build an enabled logging config with overrides over the defaults. */
function enabledConfig(over: Partial<LoggingConfig> = {}): LoggingConfig {
  return { ...defaultLoggingConfig(), enabled: true, ...over };
}

/** Create an enabled logger writing parsed JSON records into `lines`. */
function captureLogger(cfg: LoggingConfig, now?: () => number) {
  const lines: Record<string, unknown>[] = [];
  const logger = createDaemonLogger(cfg, process.env, {
    sink: (line) => lines.push(JSON.parse(line)),
    ...(now ? { now } : {}),
  });
  return { logger, lines };
}

describe("createDaemonLogger", () => {
  test("returns a no-op logger when disabled", () => {
    let called = false;
    const logger = createDaemonLogger(defaultLoggingConfig(), process.env, {
      sink: () => {
        called = true;
      },
    });
    expect(logger.enabled).toBe(false);
    expect(logger.file).toBeUndefined();
    logger.module("perf").info("hi", { a: 1 });
    expect(called).toBe(false);
    expect(logger.module("perf").isEnabled("error")).toBe(false);
  });

  test("emits a JSON-lines record with stable + merged fields", () => {
    const { logger, lines } = captureLogger(
      enabledConfig({ level: "info" }),
      () => 1_700_000_000_000,
    );
    logger.module("agent-activity").info("transition", { sid: "t-1", to: "working" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      ts: "2023-11-14T22:13:20.000Z",
      level: "info",
      module: "agent-activity",
      msg: "transition",
      sid: "t-1",
      to: "working",
    });
  });

  test("drops records below the module threshold", () => {
    const { logger, lines } = captureLogger(enabledConfig({ level: "info" }));
    const m = logger.module("perf");
    m.debug("below");
    m.trace("below");
    m.info("at");
    m.warn("above");
    m.error("above");
    expect(lines.map((l) => l.msg)).toEqual(["at", "above", "above"]);
  });

  test("a per-module override takes precedence over the global level", () => {
    const { logger, lines } = captureLogger(
      enabledConfig({ level: "info", modules: { "agent-activity": "trace" } }),
    );
    logger.module("agent-activity").trace("chase");
    logger.module("terminal").trace("dropped");
    expect(lines.map((l) => `${l.module}:${l.msg}`)).toEqual([
      "agent-activity:chase",
    ]);
  });

  test("a module set to off is silenced entirely", () => {
    const { logger, lines } = captureLogger(
      enabledConfig({ level: "info", modules: { terminal: "off" } }),
    );
    logger.module("terminal").error("still dropped");
    expect(lines).toHaveLength(0);
  });

  test("redacts prompt text by default, replacing it with a length", () => {
    const { logger, lines } = captureLogger(enabledConfig({ level: "info" }));
    logger.module("agent-activity").info("title.apply", {
      sid: "t-1",
      title: "Refactor the auth module",
      query: "secret",
    });
    expect(lines[0]).not.toHaveProperty("title");
    expect(lines[0]).not.toHaveProperty("query");
    expect(lines[0]!["title.len"]).toBe(24);
    expect(lines[0]!["query.len"]).toBe(6);
    expect(lines[0]!.sid).toBe("t-1");
  });

  test("includes prompt text when redaction is disabled", () => {
    const { logger, lines } = captureLogger(
      enabledConfig({ level: "info", redactPrompts: false }),
    );
    logger.module("agent-activity").info("title.apply", { title: "Hello world" });
    expect(lines[0]!.title).toBe("Hello world");
    expect(lines[0]).not.toHaveProperty("title.len");
  });
});

describe("daemon logger file sink", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wos-logsink-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("appends JSON lines to the configured file across loggers", async () => {
    const file = join(tmp, "daemon.log");
    const cfg = enabledConfig({ level: "info", file });

    const first = createDaemonLogger(cfg);
    expect(first.enabled).toBe(true);
    expect(first.file).toBe(file);
    first.module("perf").info("one");
    first.module("perf").info("two");
    await first.close();

    // A second logger appends rather than truncating.
    const second = createDaemonLogger(cfg);
    second.module("perf").info("three");
    await second.close();

    const text = await readFile(file, "utf8");
    const records = text
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(records.map((r) => r.msg)).toEqual(["one", "two", "three"]);
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("ModuleLogger.span / spanSync", () => {
  test("records duration and ok on completion", async () => {
    let clock = 0;
    const { logger, lines } = captureLogger(
      enabledConfig({ level: "debug" }),
      () => clock,
    );
    const result = await logger.module("perf").span(
      "git",
      "status",
      async () => {
        clock = 42;
        return "done";
      },
    );
    expect(result).toBe("done");
    const span = lines.find((l) => l.msg === "span.end");
    expect(span).toMatchObject({
      level: "debug",
      op: "git",
      label: "status",
      durationMs: 42,
      ok: true,
    });
    expect(span).not.toHaveProperty("slow");
  });

  test("elevates a slow span to warn", async () => {
    let clock = 0;
    const { logger, lines } = captureLogger(
      enabledConfig({ level: "debug" }),
      () => clock,
    );
    await logger.module("perf").span("git", "fetch", async () => {
      clock = 1500; // >= default slowMs (1000)
    });
    const span = lines.find((l) => l.msg === "span.end");
    expect(span).toMatchObject({ level: "warn", durationMs: 1500, slow: true });
  });

  test("records ok=false when the operation throws", async () => {
    const { logger, lines } = captureLogger(enabledConfig({ level: "debug" }));
    await expect(
      logger.module("perf").span("git", "boom", async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(lines.find((l) => l.msg === "span.end")).toMatchObject({ ok: false });
  });

  test("stuck watchdog fires before a slow operation completes", async () => {
    const { logger, lines } = captureLogger(enabledConfig({ level: "debug" }));
    await logger
      .module("perf")
      .span("git", "hang", () => Bun.sleep(40), { slowMs: 5 });
    const stuckIdx = lines.findIndex((l) => l.msg === "span.stuck");
    const endIdx = lines.findIndex((l) => l.msg === "span.end");
    expect(stuckIdx).toBeGreaterThanOrEqual(0);
    expect(lines[stuckIdx]).toMatchObject({ level: "warn", op: "git", elapsedMs: 5 });
    // The stuck record is emitted before the completion record.
    expect(stuckIdx).toBeLessThan(endIdx);
  });

  test("a fast operation emits no stuck record", async () => {
    const { logger, lines } = captureLogger(enabledConfig({ level: "debug" }));
    await logger
      .module("perf")
      .span("git", "quick", async () => "ok", { slowMs: 1000 });
    expect(lines.some((l) => l.msg === "span.stuck")).toBe(false);
  });

  test("disabled perf bypasses timing entirely", async () => {
    const { logger, lines } = captureLogger(
      enabledConfig({ level: "debug", perf: { enabled: false, stuckWatchdog: true, slowMs: { default: 1 } } }),
    );
    const result = await logger
      .module("perf")
      .span("git", "x", () => Bun.sleep(20).then(() => 7), { slowMs: 1 });
    expect(result).toBe(7);
    expect(lines.some((l) => l.msg === "span.end" || l.msg === "span.stuck")).toBe(
      false,
    );
  });

  test("spanSync times a synchronous operation", () => {
    let clock = 0;
    const { logger, lines } = captureLogger(
      enabledConfig({ level: "debug" }),
      () => clock,
    );
    const out = logger.module("perf").spanSync("process-detect", "1000", () => {
      clock = 3;
      return 99;
    });
    expect(out).toBe(99);
    expect(lines.find((l) => l.msg === "span.end")).toMatchObject({
      op: "process-detect",
      durationMs: 3,
      ok: true,
    });
  });
});
