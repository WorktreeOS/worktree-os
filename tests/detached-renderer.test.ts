import { test, expect, describe } from "bun:test";
import { detachedRenderer } from "@worktreeos/ui/detached-renderer";

function makeSinks() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: {
      out: (t: string) => void out.push(t),
      err: (t: string) => void err.push(t),
    },
  };
}

describe("detachedRenderer action log", () => {
  test("prints step lifecycle lines to stderr", () => {
    const { err, out, write } = makeSinks();
    const r = detachedRenderer({
      out: write.out,
      err: write.err,
      spinnerEnabled: false,
    });
    r.observer.emit({ type: "step", id: "compose-up", state: "running" });
    r.observer.emit({ type: "step", id: "compose-up", state: "done" });
    const text = err.join("");
    expect(text).toContain("▸ docker compose up");
    expect(text).toContain("✓ docker compose up");
    expect(out.join("")).toBe("");
  });

  test("uses a neutral, Docker-free startup label in shell mode", () => {
    const { err, write } = makeSinks();
    const r = detachedRenderer({
      out: write.out,
      err: write.err,
      spinnerEnabled: false,
      mode: "shell",
    });
    r.observer.emit({ type: "step", id: "compose-up", state: "running" });
    r.observer.emit({ type: "step", id: "compose-up", state: "done" });
    const text = err.join("");
    expect(text).toContain("▸ Start services");
    expect(text).toContain("✓ Start services");
    expect(text).not.toContain("docker compose");
  });

  test("renders step failures with the failure message", () => {
    const { err, write } = makeSinks();
    const r = detachedRenderer({
      out: write.out,
      err: write.err,
      spinnerEnabled: false,
    });
    r.observer.emit({ type: "step", id: "compose-up", state: "running" });
    r.observer.emit({
      type: "step",
      id: "compose-up",
      state: "failed",
      message: "exit 1",
    });
    const text = err.join("");
    expect(text).toContain("✗ docker compose up: exit 1");
  });

  test("renders retry events", () => {
    const { err, write } = makeSinks();
    const r = detachedRenderer({
      out: write.out,
      err: write.err,
      spinnerEnabled: false,
    });
    r.observer.emit({
      type: "retry",
      attempt: 2,
      maxAttempts: 3,
      reason: "port conflict on 20100",
    });
    const text = err.join("");
    expect(text).toContain("[retry 2/3] port conflict on 20100");
  });

  test("suppresses deployment stdout and forwards only deployment stderr", () => {
    const { out, err, write } = makeSinks();
    const r = detachedRenderer({
      out: write.out,
      err: write.err,
      spinnerEnabled: false,
    });
    r.observer.emit({
      type: "log",
      channel: "deployment",
      stream: "stdout",
      chunk: "compose-ps-json-dump\n",
    });
    r.observer.emit({
      type: "log",
      channel: "deployment",
      stream: "stderr",
      chunk: "compose stderr\n",
    });
    expect(out.join("")).toBe("");
    const errText = err.join("");
    expect(errText).not.toContain("compose-ps-json-dump");
    expect(errText).toContain("compose stderr");
  });

  test("does not echo the daemon-side formatStatus emitted as a deployment-stdout chunk", () => {
    const { out, err, write } = makeSinks();
    const r = detachedRenderer({
      out: write.out,
      err: write.err,
      spinnerEnabled: false,
    });
    // Daemon's runUpProgram sinks `stdout(formatStatus(services))` into a
    // deployment-stdout log event. Detached CLI prints its own summary, so
    // this echo must not surface anywhere or the user sees the table twice.
    r.observer.emit({
      type: "log",
      channel: "deployment",
      stream: "stdout",
      chunk:
        "api          running  127.0.0.1:29325 -> 4010/tcp\n" +
        "app          running  127.0.0.1:27446 -> 4200/tcp\n",
    });
    expect(out.join("")).toBe("");
    expect(err.join("")).not.toContain("127.0.0.1");
  });

  test("forwards failure events to stderr", () => {
    const { err, write } = makeSinks();
    const r = detachedRenderer({
      out: write.out,
      err: write.err,
      spinnerEnabled: false,
    });
    r.observer.emit({ type: "failure", message: "boom" });
    expect(err.join("")).toContain("[failure] boom");
  });
});

describe("detachedRenderer spinner lifecycle", () => {
  test("starts a spinner on step:running and clears it on step:done", () => {
    const { err, write } = makeSinks();
    const r = detachedRenderer({
      out: write.out,
      err: write.err,
      spinnerEnabled: true,
      manualSpinner: true,
    });
    expect(r.__test.hasActiveSpinner()).toBe(false);
    r.observer.emit({ type: "step", id: "compose-up", state: "running" });
    expect(r.__test.hasActiveSpinner()).toBe(true);
    // Initial frame should already have been written.
    const initialErr = err.join("");
    expect(initialErr).toMatch(/⠋ docker compose up/);

    // A manual tick advances to the next frame and writes another spinner line.
    const before = err.length;
    const nextFrame = r.__test.tick();
    expect(nextFrame).toBeTruthy();
    expect(err.length).toBeGreaterThan(before);

    r.observer.emit({ type: "step", id: "compose-up", state: "done" });
    expect(r.__test.hasActiveSpinner()).toBe(false);
    // Last write should clear the spinner line before printing the done marker.
    const tail = err.slice(-3).join("");
    expect(tail).toContain("\r\x1b[2K");
    expect(tail).toContain("✓ docker compose up");
  });

  test("stop() releases the spinner interval", () => {
    const { write } = makeSinks();
    const r = detachedRenderer({
      out: write.out,
      err: write.err,
      spinnerEnabled: true,
      manualSpinner: true,
    });
    r.observer.emit({ type: "step", id: "compose-up", state: "running" });
    expect(r.__test.hasActiveSpinner()).toBe(true);
    r.stop();
    expect(r.__test.hasActiveSpinner()).toBe(false);
  });

  test("failure event stops the spinner", () => {
    const { err, write } = makeSinks();
    const r = detachedRenderer({
      out: write.out,
      err: write.err,
      spinnerEnabled: true,
      manualSpinner: true,
    });
    r.observer.emit({ type: "step", id: "compose-up", state: "running" });
    r.observer.emit({ type: "failure", message: "boom" });
    expect(r.__test.hasActiveSpinner()).toBe(false);
    const tail = err.slice(-3).join("");
    expect(tail).toContain("[failure] boom");
  });

  test("spinner is suppressed when spinnerEnabled is false", () => {
    const { err, write } = makeSinks();
    const r = detachedRenderer({
      out: write.out,
      err: write.err,
      spinnerEnabled: false,
    });
    r.observer.emit({ type: "step", id: "compose-up", state: "running" });
    // No carriage-return / clear escape should be present without the spinner.
    expect(err.join("")).not.toContain("\r");
  });
});
