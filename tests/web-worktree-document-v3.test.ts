import { describe, expect, test } from "bun:test";

describe("routes/worktree/document (v3)", () => {
  test("exports Document with Head/Body/Footer/Section", async () => {
    const mod = await import("../apps/web/src/routes/worktree/document");
    expect(typeof mod.Document).toBe("function");
    expect(typeof mod.DocumentHead).toBe("function");
    expect(typeof mod.DocumentBody).toBe("function");
    expect(typeof mod.DocumentFooter).toBe("function");
    expect(typeof mod.DocumentSection).toBe("function");
    expect(typeof mod.Document.Head).toBe("function");
    expect(typeof mod.Document.Body).toBe("function");
    expect(typeof mod.Document.Footer).toBe("function");
    expect(typeof mod.Document.Section).toBe("function");
  });
});

describe("routes/worktree/context-line (v3)", () => {
  test("exports ContextLine", async () => {
    const mod = await import("../apps/web/src/routes/worktree/context-line");
    expect(typeof mod.ContextLine).toBe("function");
  });
});
