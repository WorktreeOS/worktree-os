import { test, expect, describe } from "bun:test";
import {
  commitMessageFieldsFromSnapshot,
  commitMessagesDraftFromFields,
  commitMessageProviderIsKnown,
} from "./commit-message-settings";
import type { SettingsConfigSnapshot } from "./ui-api";

function snap(
  raw: { provider?: string; model?: string } | undefined,
  eff: { provider?: string; model?: string },
): Pick<SettingsConfigSnapshot, "raw" | "effective"> {
  return {
    raw: raw ? ({ commitMessages: raw } as any) : null,
    effective: { commitMessages: eff } as any,
  };
}

describe("commitMessageFieldsFromSnapshot", () => {
  test("prefers raw over effective", () => {
    const fields = commitMessageFieldsFromSnapshot(
      snap({ provider: "raw", model: "raw-m" }, { provider: "eff", model: "eff-m" }),
    );
    expect(fields).toEqual({ provider: "raw", model: "raw-m" });
  });

  test("falls back to effective when raw is absent", () => {
    const fields = commitMessageFieldsFromSnapshot(
      snap(undefined, { provider: "eff", model: "eff-m" }),
    );
    expect(fields).toEqual({ provider: "eff", model: "eff-m" });
  });

  test("empty when neither set", () => {
    const fields = commitMessageFieldsFromSnapshot(snap(undefined, {}));
    expect(fields).toEqual({ provider: "", model: "" });
  });
});

describe("commitMessagesDraftFromFields", () => {
  test("empty fields produce an empty draft (clears the default)", () => {
    expect(commitMessagesDraftFromFields({ provider: "", model: "" })).toEqual({});
  });

  test("provider only", () => {
    expect(
      commitMessagesDraftFromFields({ provider: "work", model: "" }),
    ).toEqual({ provider: "work" });
  });

  test("provider and model", () => {
    expect(
      commitMessagesDraftFromFields({ provider: "work", model: "m" }),
    ).toEqual({ provider: "work", model: "m" });
  });

  test("model without a provider is dropped", () => {
    expect(
      commitMessagesDraftFromFields({ provider: "", model: "m" }),
    ).toEqual({});
  });

  test("trims whitespace", () => {
    expect(
      commitMessagesDraftFromFields({ provider: "  work  ", model: "  m  " }),
    ).toEqual({ provider: "work", model: "m" });
  });
});

describe("commitMessageProviderIsKnown", () => {
  test("empty selection is always known", () => {
    expect(commitMessageProviderIsKnown("", [])).toBe(true);
  });
  test("known when the name is configured", () => {
    expect(commitMessageProviderIsKnown("work", ["work", "other"])).toBe(true);
  });
  test("unknown when the name is missing", () => {
    expect(commitMessageProviderIsKnown("gone", ["work"])).toBe(false);
  });
});
