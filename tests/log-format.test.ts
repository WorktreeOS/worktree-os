import { test, expect, describe } from "bun:test";
import {
  classifyChannel,
  composeLine,
  wosPrefix,
  formatDuration,
  formatElapsed,
  prefixChunk,
  prefixFor,
} from "@worktreeos/ui/log-format";

describe("formatDuration", () => {
  test("renders sub-second values as ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  test("renders short seconds with tenths", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(1234)).toBe("1.2s");
    expect(formatDuration(9900)).toBe("9.9s");
  });

  test("renders seconds without tenths past 10s", () => {
    expect(formatDuration(10999)).toBe("10s");
    expect(formatDuration(45000)).toBe("45s");
  });

  test("renders minutes and seconds", () => {
    expect(formatDuration(60_000)).toBe("1m00s");
    expect(formatDuration(83_500)).toBe("1m23s");
  });

  test("renders hours and minutes", () => {
    expect(formatDuration(3_600_000)).toBe("1h00m");
    expect(formatDuration(3_900_000)).toBe("1h05m");
  });

  test("clamps negative input", () => {
    expect(formatDuration(-123)).toBe("0ms");
  });
});

describe("formatElapsed", () => {
  test("renders m:ss for under an hour", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(39_000)).toBe("0:39");
    expect(formatElapsed(83_000)).toBe("1:23");
    expect(formatElapsed(605_000)).toBe("10:05");
  });

  test("renders h:mm:ss past one hour", () => {
    expect(formatElapsed(3_623_000)).toBe("1:00:23");
  });
});

describe("classifyChannel", () => {
  test("init channel is classified as init source", () => {
    expect(classifyChannel("init", "stdout")).toEqual({
      source: "init",
      stream: "stdout",
      severity: "info",
    });
    expect(classifyChannel("init", "stderr")).toEqual({
      source: "init",
      stream: "stderr",
      severity: "error",
    });
  });

  test("deployment channel is classified as compose source", () => {
    expect(classifyChannel("deployment", "stdout").source).toBe("compose");
    expect(classifyChannel("deployment", "stderr").severity).toBe("error");
  });

  test("service:<name> is classified with service name", () => {
    const d = classifyChannel("service:api", "stdout");
    expect(d.source).toBe("service");
    expect(d.serviceName).toBe("api");
  });
});

describe("prefixFor", () => {
  test("compose stdout/stderr have distinguishable prefixes", () => {
    const stdoutPrefix = prefixFor(classifyChannel("deployment", "stdout"));
    const stderrPrefix = prefixFor(classifyChannel("deployment", "stderr"));
    expect(stdoutPrefix).toBe("[compose]");
    expect(stderrPrefix).toBe("[compose err]");
    expect(stdoutPrefix).not.toBe(stderrPrefix);
  });

  test("init stdout and stderr are distinguishable", () => {
    expect(prefixFor(classifyChannel("init", "stdout"))).toBe("[init]");
    expect(prefixFor(classifyChannel("init", "stderr"))).toBe("[init err]");
  });

  test("service prefix includes the service name", () => {
    expect(prefixFor(classifyChannel("service:api", "stdout"))).toBe("[api]");
    expect(prefixFor(classifyChannel("service:api", "stderr"))).toBe("[api err]");
  });
});

describe("wosPrefix", () => {
  test("info/warn/error/success map to distinct labels", () => {
    expect(wosPrefix("info")).toBe("[deploy]");
    expect(wosPrefix("warn")).toBe("[warn]");
    expect(wosPrefix("error")).toBe("[fail]");
    expect(wosPrefix("success")).toBe("[ok]");
  });
});

describe("composeLine", () => {
  test("concatenates prefix and text", () => {
    expect(composeLine("[init]", "hello")).toBe("[init] hello");
  });

  test("trims trailing whitespace", () => {
    expect(composeLine("[init]", "hello\n")).toBe("[init] hello");
  });
});

describe("prefixChunk", () => {
  test("returns empty for empty chunk", () => {
    expect(prefixChunk("[init]", "")).toEqual([]);
  });

  test("prefixes each complete line and keeps newline", () => {
    expect(prefixChunk("[init]", "a\nb\n")).toEqual([
      "[init] a\n",
      "[init] b\n",
    ]);
  });

  test("preserves trailing partial line without newline", () => {
    expect(prefixChunk("[init]", "a\npartial")).toEqual([
      "[init] a\n",
      "[init] partial",
    ]);
  });
});
