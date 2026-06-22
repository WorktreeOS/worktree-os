#!/usr/bin/env bun
const argv = process.argv.slice(2);

// Fast path: `wos agent-hook <event> [--agent codex]` is the Claude Code /
// Codex plugin hook delivery command. Both agents fire PostToolUse after every
// tool call, so this must stay lightweight — it runs before, and without
// loading, the embedded web/daemon bundle that the normal CLI path wires up
// below. The import is dynamic so a heartbeat never pays for the web bundle.
// The full argv tail (including `--agent codex`) is forwarded; `runAgentHook`
// parses the flag and defaults to claude when it is absent.
if (argv[0] === "agent-hook") {
  const { runAgentHook } = await import(
    "@worktreeos/plugin-claude/src/agent-hook"
  );
  process.exit(await runAgentHook(argv.slice(1)));
}

const { setEmbeddedWebBundle, setEmbeddedPwaAssets } = await import(
  "@worktreeos/daemon/daemon-web"
);
const { embeddedWebBundle, embeddedPwaAssets } = await import("./embedded-web");
const { main } = await import("./cli");

setEmbeddedWebBundle(embeddedWebBundle);
setEmbeddedPwaAssets(embeddedPwaAssets);

const code = await main(argv);
process.exit(code);
