import { test, expect, describe } from "bun:test";
import { ChannelRegistry, LogBuffer } from "@worktreeos/ui/log-buffer";

describe("LogBuffer", () => {
  test("splits chunks on newlines and tags stream", () => {
    const buf = new LogBuffer(10);
    buf.append("stdout", "hello\nworld\n");
    expect(buf.snapshot()).toEqual([
      { stream: "stdout", text: "hello" },
      { stream: "stdout", text: "world" },
    ]);
  });

  test("retains a partial trailing line until newline arrives", () => {
    const buf = new LogBuffer(10);
    buf.append("stdout", "par");
    buf.append("stdout", "tial");
    expect(buf.snapshot()).toEqual([{ stream: "stdout", text: "partial" }]);
    buf.append("stdout", " line\n");
    expect(buf.snapshot()).toEqual([
      { stream: "stdout", text: "partial line" },
    ]);
  });

  test("caps retained lines at the configured capacity (FIFO)", () => {
    const buf = new LogBuffer(3);
    for (let i = 0; i < 10; i++) buf.append("stdout", `line-${i}\n`);
    expect(buf.snapshot().map((l) => l.text)).toEqual([
      "line-7",
      "line-8",
      "line-9",
    ]);
  });

  test("switching stream flushes pending partial line", () => {
    const buf = new LogBuffer(10);
    buf.append("stdout", "partial");
    buf.append("stderr", "err\n");
    const snap = buf.snapshot();
    expect(snap).toEqual([
      { stream: "stdout", text: "partial" },
      { stream: "stderr", text: "err" },
    ]);
  });
});

describe("ChannelRegistry", () => {
  test("ensure creates a channel and remembers ordering", () => {
    const reg = new ChannelRegistry(100, [
      { id: "deployment", label: "Deployment" },
      { id: "init", label: "Init" },
    ]);
    expect(reg.channels().map((c) => c.id)).toEqual(["deployment", "init"]);
    reg.ensure("service:api", "api");
    expect(reg.channels().map((c) => c.id)).toEqual([
      "deployment",
      "init",
      "service:api",
    ]);
  });

  test("append routes lines to the correct channel buffer", () => {
    const reg = new ChannelRegistry(10);
    reg.append("deployment", "stdout", "wos-up\n");
    reg.append("init", "stdout", "install\n");
    expect(reg.snapshot("deployment").map((l) => l.text)).toEqual(["wos-up"]);
    expect(reg.snapshot("init").map((l) => l.text)).toEqual(["install"]);
  });

  test("next/prev cycle through channels in order", () => {
    const reg = new ChannelRegistry(10, [
      { id: "deployment", label: "Deployment" },
      { id: "init", label: "Init" },
      { id: "service:api", label: "api" },
    ]);
    expect(reg.active().id).toBe("deployment");
    expect(reg.next().id).toBe("init");
    expect(reg.next().id).toBe("service:api");
    expect(reg.next().id).toBe("deployment");
    expect(reg.prev().id).toBe("service:api");
  });

  test("setActive moves selection to existing channel and is a no-op for unknown", () => {
    const reg = new ChannelRegistry(10, [
      { id: "deployment", label: "Deployment" },
      { id: "init", label: "Init" },
    ]);
    expect(reg.setActive("init")).toBe(true);
    expect(reg.active().id).toBe("init");
    expect(reg.setActive("service:missing")).toBe(false);
    expect(reg.active().id).toBe("init");
  });
});
