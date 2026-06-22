import { test, expect, describe } from "bun:test";
import {
  deriveComposerState,
  deriveQuickCommitState,
  showBranchRow,
  suggestBranchName,
} from "./review-composer-logic";

const base = {
  message: "",
  stagedCount: 2,
  aiConfigured: true,
  generating: false,
  committing: false,
};

describe("deriveComposerState", () => {
  test("AI configured + empty message → generate & commit", () => {
    const s = deriveComposerState({ ...base, message: "" });
    expect(s.mode).toBe("generate-and-commit");
    expect(s.label).toBe("Generate & commit");
    expect(s.canCommit).toBe(true);
    expect(s.showGenerateHint).toBe(true);
    expect(s.showSettingsHint).toBe(false);
    expect(s.canGenerate).toBe(true);
  });

  test("AI configured + message text → plain commit with file count", () => {
    const s = deriveComposerState({ ...base, message: "feat: x" });
    expect(s.mode).toBe("commit");
    expect(s.label).toBe("Commit 2 files");
    expect(s.canCommit).toBe(true);
    expect(s.showGenerateHint).toBe(false);
  });

  test("not configured + empty message → commit disabled, Settings hint", () => {
    const s = deriveComposerState({
      ...base,
      aiConfigured: false,
      message: "",
    });
    expect(s.mode).toBe("commit");
    expect(s.canCommit).toBe(false);
    expect(s.canGenerate).toBe(false);
    expect(s.showSettingsHint).toBe(true);
    expect(s.showGenerateHint).toBe(false);
  });

  test("not configured + message text → commit enabled", () => {
    const s = deriveComposerState({
      ...base,
      aiConfigured: false,
      message: "fix: y",
    });
    expect(s.canCommit).toBe(true);
    expect(s.showSettingsHint).toBe(false);
  });

  test("nothing staged → commit disabled", () => {
    const s = deriveComposerState({ ...base, stagedCount: 0, message: "x" });
    expect(s.canCommit).toBe(false);
  });

  test("singular file label", () => {
    const s = deriveComposerState({ ...base, stagedCount: 1, message: "x" });
    expect(s.label).toBe("Commit 1 file");
  });

  test("busy disables commit and generate", () => {
    expect(deriveComposerState({ ...base, generating: true }).canCommit).toBe(
      false,
    );
    expect(deriveComposerState({ ...base, committing: true }).canGenerate).toBe(
      false,
    );
  });
});

describe("deriveQuickCommitState", () => {
  const q = {
    message: "",
    changedCount: 3,
    aiConfigured: true,
    generating: false,
    committing: false,
  };

  test("changes + empty message + AI → can commit, will generate", () => {
    const s = deriveQuickCommitState(q);
    expect(s.canCommit).toBe(true);
    expect(s.canPush).toBe(true);
    expect(s.generates).toBe(true);
  });

  test("changes + typed message → can commit, no generation", () => {
    const s = deriveQuickCommitState({ ...q, message: "feat: x" });
    expect(s.canCommit).toBe(true);
    expect(s.generates).toBe(false);
  });

  test("no changes → disabled regardless of message", () => {
    expect(deriveQuickCommitState({ ...q, changedCount: 0 }).canCommit).toBe(
      false,
    );
    expect(
      deriveQuickCommitState({ ...q, changedCount: 0, message: "x" }).canCommit,
    ).toBe(false);
  });

  test("no AI + empty message → must type first (disabled)", () => {
    const s = deriveQuickCommitState({ ...q, aiConfigured: false });
    expect(s.canCommit).toBe(false);
    expect(s.generates).toBe(false);
  });

  test("no AI + typed message → can commit", () => {
    const s = deriveQuickCommitState({
      ...q,
      aiConfigured: false,
      message: "fix: y",
    });
    expect(s.canCommit).toBe(true);
  });

  test("busy disables the quick action", () => {
    expect(deriveQuickCommitState({ ...q, generating: true }).canCommit).toBe(
      false,
    );
    expect(deriveQuickCommitState({ ...q, committing: true }).canCommit).toBe(
      false,
    );
  });
});

describe("showBranchRow", () => {
  test("only when detached", () => {
    expect(showBranchRow(true)).toBe(true);
    expect(showBranchRow(false)).toBe(false);
  });
});

describe("suggestBranchName", () => {
  test("slugifies a display name", () => {
    expect(suggestBranchName("My Feature!")).toBe("my-feature");
  });
  test("keeps slashes and dashes", () => {
    expect(suggestBranchName("feature/Cool Thing")).toBe("feature/cool-thing");
  });
  test("falls back to work", () => {
    expect(suggestBranchName("   ")).toBe("work");
    expect(suggestBranchName("!!!")).toBe("work");
  });
  test("trims leading/trailing separators", () => {
    expect(suggestBranchName("/lead/")).toBe("lead");
  });
});
