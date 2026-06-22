import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createStatus,
  deleteStatus,
  loadStatusCatalog,
  PRESET_STATUSES,
  saveStatusCatalog,
  updateStatus,
  validateStatusColor,
  validateStatusName,
  StatusCatalogError,
} from "@worktreeos/core/status-catalog";

let tmpHome: string;
let filePath: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), "wos-statuses-"));
  filePath = join(tmpHome, "statuses.json");
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

describe("status catalog seeding", () => {
  test("seeds presets when file is absent and persists them", async () => {
    const catalog = await loadStatusCatalog({ filePath });
    expect(catalog.statuses.map((s) => s.id)).toEqual(
      PRESET_STATUSES.map((s) => s.id),
    );
    expect(catalog.statuses.map((s) => s.order)).toEqual([0, 1, 2, 3, 4]);
    // Reading again returns the persisted catalog (no re-seed surprises).
    const again = await loadStatusCatalog({ filePath });
    expect(again.statuses).toEqual(catalog.statuses);
  });

  test("preset colors avoid amber", async () => {
    const catalog = await loadStatusCatalog({ filePath });
    for (const s of catalog.statuses) {
      expect(s.color).not.toBe("#f59e0b");
    }
  });
});

describe("status catalog mutations", () => {
  test("create appends a status at the end", async () => {
    await loadStatusCatalog({ filePath });
    const { status, catalog } = await createStatus("blocked", "#EF4444", {
      filePath,
    });
    expect(status.name).toBe("blocked");
    expect(status.color).toBe("#ef4444");
    expect(catalog.statuses[catalog.statuses.length - 1]!.id).toBe(status.id);
    expect(status.order).toBe(catalog.statuses.length - 1);
  });

  test("rename and recolor preserve the id", async () => {
    const updated = await updateStatus(
      "review",
      { name: "in review", color: "#A855F7" },
      { filePath },
    );
    expect(updated).not.toBeNull();
    expect(updated!.status.id).toBe("review");
    expect(updated!.status.name).toBe("in review");
    expect(updated!.status.color).toBe("#a855f7");
  });

  test("update order moves the status to the target index", async () => {
    // Move "merged" (index 4) to the front (index 0).
    const updated = await updateStatus("merged", { order: 0 }, { filePath });
    expect(updated).not.toBeNull();
    expect(updated!.catalog.statuses[0]!.id).toBe("merged");
    expect(updated!.catalog.statuses.map((s) => s.order)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  test("delete removes the status and renormalizes order", async () => {
    const catalog = await deleteStatus("develop", { filePath });
    expect(catalog).not.toBeNull();
    expect(catalog!.statuses.some((s) => s.id === "develop")).toBe(false);
    expect(catalog!.statuses.map((s) => s.order)).toEqual([0, 1, 2, 3]);
  });

  test("update returns null for unknown id", async () => {
    await loadStatusCatalog({ filePath });
    const updated = await updateStatus("nope", { name: "x" }, { filePath });
    expect(updated).toBeNull();
  });

  test("create rejects invalid name and color", async () => {
    await loadStatusCatalog({ filePath });
    await expect(createStatus("   ", "#fff", { filePath })).rejects.toBeInstanceOf(
      StatusCatalogError,
    );
    await expect(
      createStatus("ok", "not-a-color", { filePath }),
    ).rejects.toBeInstanceOf(StatusCatalogError);
  });
});

describe("status field validation", () => {
  test("name validation", () => {
    expect(validateStatusName("review").ok).toBe(true);
    expect(validateStatusName("").ok).toBe(false);
    expect(validateStatusName("x".repeat(61)).ok).toBe(false);
  });
  test("color validation normalizes to lowercase", () => {
    const v = validateStatusColor("#ABCDEF");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value).toBe("#abcdef");
    expect(validateStatusColor("#GGGGGG").ok).toBe(false);
  });
});

describe("status catalog sanitization", () => {
  test("drops malformed entries on load", async () => {
    await saveStatusCatalog(
      {
        version: 1,
        statuses: [
          { id: "ok", name: "ok", color: "#123456", order: 0 },
          // @ts-expect-error intentionally malformed
          { id: "bad", color: "#123" },
        ],
      },
      { filePath },
    );
    const catalog = await loadStatusCatalog({ filePath });
    expect(catalog.statuses.map((s) => s.id)).toEqual(["ok"]);
  });
});
