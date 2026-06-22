import { test, expect, describe } from "bun:test";
import { plainRenderer } from "@worktreeos/ui/renderer";

describe("plainRenderer", () => {
  test("start/stop are noops", async () => {
    const r = plainRenderer();
    await r.start();
    await r.stop();
  });

  test("observer.emit covers all event types without throwing", () => {
    const r = plainRenderer();
    // We don't capture process.stdout here — the assertion is that emit() does
    // not throw for any defined event type and that the observer is wired.
    r.observer.emit({ type: "step", id: "compose-up", state: "running" });
    r.observer.emit({ type: "retry", attempt: 1, maxAttempts: 3, reason: "x" });
    r.observer.emit({ type: "failure", message: "boom" });
    r.observer.emit({
      type: "services-discovered",
      services: ["api"],
      composeContext: { projectName: "p", composeFile: "/c.yaml" },
    });
    r.observer.emit({ type: "complete", lastUp: "2026-05-12T12:00:00.000Z" });
    expect(true).toBe(true);
  });
});
