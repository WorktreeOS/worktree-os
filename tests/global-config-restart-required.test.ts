import { test, expect, describe } from "bun:test";
import {
  defaultGlobalConfig,
  diffChangedPaths,
  restartRequiredForSave,
  type GlobalConfig,
} from "@worktreeos/core/global-config";

// Deep-clone a fresh default config so each case mutates an isolated copy.
function base(): GlobalConfig {
  return JSON.parse(JSON.stringify(defaultGlobalConfig())) as GlobalConfig;
}

describe("diffChangedPaths", () => {
  test("no change yields no paths", () => {
    expect(diffChangedPaths(base(), base())).toEqual([]);
  });

  test("reports a changed top-level leaf", () => {
    const next = base();
    next.web.port = 5000;
    expect(diffChangedPaths(base(), next)).toContain("web.port");
  });

  test("reports a nested whitelist change at its own path", () => {
    const next = base();
    next.tunnel.serviceTunnels.whitelistIps = ["10.0.0.1"];
    const changed = diffChangedPaths(base(), next);
    expect(changed).toContain("tunnel.serviceTunnels.whitelistIps");
    expect(changed).not.toContain("tunnel.serviceTunnels.enabled");
  });

  test("reports nested ssl and logging changes", () => {
    const next = base();
    next.web.ssl = { enabled: true, source: "self-signed" };
    next.logging.level = "debug";
    const changed = diffChangedPaths(base(), next);
    expect(changed.some((p) => p.startsWith("web.ssl"))).toBe(true);
    expect(changed.some((p) => p.startsWith("logging"))).toBe(true);
  });
});

describe("restartRequiredForSave", () => {
  test("no-op save does not require restart", () => {
    expect(restartRequiredForSave(base(), base())).toBe(false);
  });

  test("socket-field change requires restart", () => {
    const port = base();
    port.web.port = 5000;
    expect(restartRequiredForSave(base(), port)).toBe(true);

    const host = base();
    host.web.host = "0.0.0.0";
    expect(restartRequiredForSave(base(), host)).toBe(true);

    const tunnelEnabled = base();
    tunnelEnabled.tunnel.enabled = true;
    expect(restartRequiredForSave(base(), tunnelEnabled)).toBe(true);

    const tunnelPort = base();
    tunnelPort.tunnel.port = 6000;
    expect(restartRequiredForSave(base(), tunnelPort)).toBe(true);
  });

  test("ssl / terminalBackend / autoInject / logging changes require restart", () => {
    const ssl = base();
    ssl.web.ssl = { enabled: true, source: "self-signed" };
    expect(restartRequiredForSave(base(), ssl)).toBe(true);

    const backend = base();
    backend.terminalBackend = "tmux";
    expect(restartRequiredForSave(base(), backend)).toBe(true);

    const autoInject = base();
    autoInject.autoInjectAgentPlugins = true;
    expect(restartRequiredForSave(base(), autoInject)).toBe(true);

    const logging = base();
    logging.logging.enabled = true;
    expect(restartRequiredForSave(base(), logging)).toBe(true);
  });

  test("serviceTunnels.enabled change requires restart", () => {
    const next = base();
    next.tunnel.serviceTunnels.enabled = true;
    expect(restartRequiredForSave(base(), next)).toBe(true);
  });

  test("live-applicable-only changes do not require restart", () => {
    const aiProviders = base();
    aiProviders.aiProviders = [
      { name: "p", type: "anthropic", apiKey: "k" },
    ] as GlobalConfig["aiProviders"];
    expect(restartRequiredForSave(base(), aiProviders)).toBe(false);

    const commit = base();
    commit.commitMessages = { provider: "p", model: "m" };
    expect(restartRequiredForSave(base(), commit)).toBe(false);

    const editor = base();
    editor.editorCommand = "code {path}";
    expect(restartRequiredForSave(base(), editor)).toBe(false);

    const healthcheck = base();
    healthcheck.healthcheck = { timeoutMs: 1234 };
    expect(restartRequiredForSave(base(), healthcheck)).toBe(false);

    const whitelist = base();
    whitelist.tunnel.serviceTunnels.whitelistIps = ["10.0.0.1"];
    expect(restartRequiredForSave(base(), whitelist)).toBe(false);
  });

  test("unknown/new field change errs toward requiring restart", () => {
    const next = base() as GlobalConfig & { somethingNew?: unknown };
    (next as { somethingNew?: unknown }).somethingNew = { a: 1 };
    expect(restartRequiredForSave(base(), next)).toBe(true);
  });
});
