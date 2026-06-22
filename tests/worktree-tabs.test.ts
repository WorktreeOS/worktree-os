import { test, expect, describe } from "bun:test";
import {
  initialSurfaceState,
  initialWorktreeTab,
  LEGACY_RIGHT_PANEL_VISIBILITY_STORAGE_KEY,
  logChannelAvailable,
  migrateLegacyPanelVisibility,
  normalizeLogsChannelForServices,
  normalizeStoredTab,
  normalizeTabForWorktreeSwitch,
  persistWorktreeTab,
  readStoredWorktreeTab,
  selectTab,
  selectTerminalSession,
  setLogsChannel,
  WORKTREE_TAB_STORAGE_KEY,
  type WorktreeSurfaceState,
} from "../apps/web/src/lib/worktree-tabs";

function makeMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => Array.from(data.keys())[index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  } as Storage;
}

describe("initialSurfaceState", () => {
  test("defaults to the overview tab with no channel or session", () => {
    expect(initialSurfaceState()).toEqual({
      tab: "overview",
      logsChannel: null,
      terminalSessionId: null,
    });
  });

  test("a runtime starting tab defaults the log channel to init", () => {
    expect(initialSurfaceState("runtime")).toEqual({
      tab: "runtime",
      logsChannel: "init",
      terminalSessionId: null,
    });
  });
});

describe("selectTab transitions", () => {
  test("selecting runtime from overview defaults the log channel to init", () => {
    const next = selectTab(initialSurfaceState(), "runtime");
    expect(next).toEqual({
      tab: "runtime",
      logsChannel: "init",
      terminalSessionId: null,
    });
  });

  test("selecting runtime with an explicit channel uses it", () => {
    const next = selectTab(initialSurfaceState(), "runtime", {
      logsChannel: "service:api",
    });
    expect(next.logsChannel).toBe("service:api");
  });

  test("selecting a non-runtime tab preserves the existing log channel", () => {
    const prev: WorktreeSurfaceState = {
      tab: "runtime",
      logsChannel: "service:web",
      terminalSessionId: null,
    };
    const next = selectTab(prev, "review");
    expect(next).toEqual({
      tab: "review",
      logsChannel: "service:web",
      terminalSessionId: null,
    });
  });

  test("re-selecting runtime keeps the existing channel when none is provided", () => {
    const prev: WorktreeSurfaceState = {
      tab: "review",
      logsChannel: "service:web",
      terminalSessionId: null,
    };
    expect(selectTab(prev, "runtime").logsChannel).toBe("service:web");
  });

  test("selecting terminal with an explicit session id focuses it", () => {
    const next = selectTab(initialSurfaceState(), "terminal", {
      terminalSessionId: "session-42",
    });
    expect(next).toMatchObject({ tab: "terminal", terminalSessionId: "session-42" });
  });

  test("selecting overview, files, and terminal carries no log channel of their own", () => {
    expect(selectTab(initialSurfaceState(), "files").logsChannel).toBeNull();
    expect(selectTab(initialSurfaceState(), "terminal").logsChannel).toBeNull();
    expect(selectTab(initialSurfaceState(), "overview").logsChannel).toBeNull();
  });
});

describe("setLogsChannel selects the runtime tab", () => {
  test("switches to runtime and selects the channel from any tab", () => {
    const prev: WorktreeSurfaceState = {
      tab: "review",
      logsChannel: null,
      terminalSessionId: null,
    };
    expect(setLogsChannel(prev, "service:api")).toMatchObject({
      tab: "runtime",
      logsChannel: "service:api",
    });
  });

  test("a service-row open-logs then init keeps runtime selected", () => {
    let state = selectTab(initialSurfaceState(), "runtime");
    state = setLogsChannel(state, "service:api");
    expect(state).toMatchObject({ tab: "runtime", logsChannel: "service:api" });
    state = setLogsChannel(state, "init");
    expect(state).toMatchObject({ tab: "runtime", logsChannel: "init" });
  });
});

describe("selectTerminalSession", () => {
  test("a real id selects the terminal tab and focuses it", () => {
    const next = selectTerminalSession(initialSurfaceState(), "session-7");
    expect(next).toMatchObject({ tab: "terminal", terminalSessionId: "session-7" });
  });

  test("null clears a pending request in place without changing the tab", () => {
    const prev: WorktreeSurfaceState = {
      tab: "terminal",
      logsChannel: null,
      terminalSessionId: "session-7",
    };
    expect(selectTerminalSession(prev, null)).toMatchObject({
      tab: "terminal",
      terminalSessionId: null,
    });
  });

  test("clearing an already-empty request is a no-op (same reference)", () => {
    const prev: WorktreeSurfaceState = {
      tab: "review",
      logsChannel: null,
      terminalSessionId: null,
    };
    expect(selectTerminalSession(prev, null)).toBe(prev);
  });
});

describe("normalizeTabForWorktreeSwitch", () => {
  test("keeps the selected tab and log channel", () => {
    const prev: WorktreeSurfaceState = {
      tab: "runtime",
      logsChannel: "service:web",
      terminalSessionId: null,
    };
    expect(normalizeTabForWorktreeSwitch(prev)).toBe(prev);
  });

  test("clears a stale terminal session id but keeps the terminal tab", () => {
    const prev: WorktreeSurfaceState = {
      tab: "terminal",
      logsChannel: null,
      terminalSessionId: "session-from-previous-worktree",
    };
    expect(normalizeTabForWorktreeSwitch(prev)).toMatchObject({
      tab: "terminal",
      terminalSessionId: null,
    });
  });
});

describe("logChannelAvailable", () => {
  test("init is always available", () => {
    expect(logChannelAvailable("init", [])).toBe(true);
  });

  test("service channel is available only when the service exists", () => {
    expect(logChannelAvailable("service:api", ["api", "web"])).toBe(true);
    expect(logChannelAvailable("service:api", ["web"])).toBe(false);
  });
});

describe("normalizeLogsChannelForServices", () => {
  test("null channel and valid channels pass through unchanged", () => {
    const noChannel: WorktreeSurfaceState = {
      tab: "review",
      logsChannel: null,
      terminalSessionId: null,
    };
    expect(normalizeLogsChannelForServices(noChannel, [])).toBe(noChannel);
    const valid: WorktreeSurfaceState = {
      tab: "runtime",
      logsChannel: "service:api",
      terminalSessionId: null,
    };
    expect(normalizeLogsChannelForServices(valid, ["api"])).toBe(valid);
  });

  test("falls back to init when the selected service is gone", () => {
    const prev: WorktreeSurfaceState = {
      tab: "runtime",
      logsChannel: "service:api",
      terminalSessionId: null,
    };
    expect(normalizeLogsChannelForServices(prev, ["web"])).toMatchObject({
      tab: "runtime",
      logsChannel: "init",
    });
  });
});

describe("normalizeStoredTab", () => {
  test("maps the legacy logs tab to runtime", () => {
    expect(normalizeStoredTab("logs")).toBe("runtime");
  });

  test("accepts all current tabs and rejects unknown values", () => {
    for (const tab of ["overview", "runtime", "review", "files", "terminal"]) {
      expect(normalizeStoredTab(tab)).toBe(tab as never);
    }
    expect(normalizeStoredTab("bogus")).toBeNull();
  });
});

describe("readStoredWorktreeTab / persistWorktreeTab", () => {
  test("round-trips the selected tab via the new storage key", () => {
    const storage = makeMemoryStorage();
    expect(readStoredWorktreeTab(storage)).toBeNull();
    persistWorktreeTab("review", storage);
    expect(storage.getItem(WORKTREE_TAB_STORAGE_KEY)).toBe("review");
    expect(readStoredWorktreeTab(storage)).toBe("review");
  });

  test("a legacy logs value in the new key restores as runtime", () => {
    const storage = makeMemoryStorage();
    storage.setItem(WORKTREE_TAB_STORAGE_KEY, "logs");
    expect(readStoredWorktreeTab(storage)).toBe("runtime");
  });

  test("an invalid new-key value falls through to migration / null", () => {
    const storage = makeMemoryStorage();
    storage.setItem(WORKTREE_TAB_STORAGE_KEY, "bogus");
    expect(readStoredWorktreeTab(storage)).toBeNull();
  });
});

describe("migrateLegacyPanelVisibility", () => {
  test("an open panel restores the equivalent tab", () => {
    const storage = makeMemoryStorage();
    storage.setItem(
      LEGACY_RIGHT_PANEL_VISIBILITY_STORAGE_KEY,
      JSON.stringify({ open: true, tab: "review" }),
    );
    expect(migrateLegacyPanelVisibility(storage)).toBe("review");
  });

  test("an open legacy logs panel restores as runtime", () => {
    const storage = makeMemoryStorage();
    storage.setItem(
      LEGACY_RIGHT_PANEL_VISIBILITY_STORAGE_KEY,
      JSON.stringify({ open: true, tab: "logs" }),
    );
    expect(migrateLegacyPanelVisibility(storage)).toBe("runtime");
  });

  test("a closed panel restores as overview", () => {
    const storage = makeMemoryStorage();
    storage.setItem(
      LEGACY_RIGHT_PANEL_VISIBILITY_STORAGE_KEY,
      JSON.stringify({ open: false, tab: "review" }),
    );
    expect(migrateLegacyPanelVisibility(storage)).toBe("overview");
  });

  test("malformed or unknown-tab payloads migrate to null", () => {
    const storage = makeMemoryStorage();
    storage.setItem(LEGACY_RIGHT_PANEL_VISIBILITY_STORAGE_KEY, "not-json");
    expect(migrateLegacyPanelVisibility(storage)).toBeNull();
    storage.setItem(
      LEGACY_RIGHT_PANEL_VISIBILITY_STORAGE_KEY,
      JSON.stringify({ open: true, tab: "bogus" }),
    );
    expect(migrateLegacyPanelVisibility(storage)).toBeNull();
  });

  test("returns null when nothing legacy is stored", () => {
    expect(migrateLegacyPanelVisibility(makeMemoryStorage())).toBeNull();
  });
});

describe("readStoredWorktreeTab prefers the new key over legacy migration", () => {
  test("the new key wins when both are present", () => {
    const storage = makeMemoryStorage();
    storage.setItem(WORKTREE_TAB_STORAGE_KEY, "files");
    storage.setItem(
      LEGACY_RIGHT_PANEL_VISIBILITY_STORAGE_KEY,
      JSON.stringify({ open: true, tab: "review" }),
    );
    expect(readStoredWorktreeTab(storage)).toBe("files");
  });

  test("falls back to migrating the legacy value when the new key is absent", () => {
    const storage = makeMemoryStorage();
    storage.setItem(
      LEGACY_RIGHT_PANEL_VISIBILITY_STORAGE_KEY,
      JSON.stringify({ open: true, tab: "terminal" }),
    );
    expect(readStoredWorktreeTab(storage)).toBe("terminal");
  });
});

describe("initialWorktreeTab", () => {
  test("defaults to overview when nothing is stored", () => {
    expect(initialWorktreeTab(makeMemoryStorage())).toBe("overview");
  });

  test("a closed legacy panel lands on overview", () => {
    const storage = makeMemoryStorage();
    storage.setItem(
      LEGACY_RIGHT_PANEL_VISIBILITY_STORAGE_KEY,
      JSON.stringify({ open: false, tab: "runtime" }),
    );
    expect(initialWorktreeTab(storage)).toBe("overview");
  });
});
