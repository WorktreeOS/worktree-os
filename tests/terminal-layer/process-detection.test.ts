import { describe, expect, test } from "bun:test";
import { processDetectionInternals } from "@worktreeos/daemon/terminal-layer/process-detection";

const {
  parseProcessList,
  parseWindowsProcessList,
  selectActiveCommand,
  selectActiveCommandWindows,
  detectKnownAgent,
} = processDetectionInternals;

describe("terminal process detection", () => {
  test("parses ps rows with argv payloads", () => {
    const rows = parseProcessList(
      " 100  1 100 101 /bin/zsh /bin/zsh -l\n 101 100 101 101 /usr/bin/codex codex --model gpt-5\n",
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]!.args).toBe("codex --model gpt-5");
  });

  test("selects the foreground agent command below the shell", () => {
    const rows = parseProcessList(
      [
        " 100  1 100 101 /bin/zsh /bin/zsh -l",
        " 101 100 101 101 /usr/local/bin/codex codex",
        " 102 101 101 101 /usr/bin/node node /opt/codex/worker.js",
      ].join("\n"),
    );
    const active = selectActiveCommand(rows, 100);
    expect(active?.agent).toBe("codex");
    expect(active?.pid).toBe(101);
  });

  test("matches wrapper commands by argv for future extension", () => {
    expect(
      detectKnownAgent({
        command: "/usr/local/bin/bun",
        args: "bunx opencode",
      }),
    ).toBe("opencode");
    expect(
      detectKnownAgent({
        command: "/usr/local/bin/node",
        args: "node /usr/local/bin/claude-code",
      }),
    ).toBe("claude");
  });

  test("returns no active command when only the shell is foreground", () => {
    const rows = parseProcessList(" 100  1 100 100 /bin/zsh /bin/zsh -l\n");
    expect(selectActiveCommand(rows, 100)).toBeUndefined();
  });
});

describe("terminal process detection (Windows)", () => {
  test("parses CIM JSON array and a bare single object", () => {
    const arr = parseWindowsProcessList(
      JSON.stringify([
        { ProcessId: 10, ParentProcessId: 4, Name: "powershell.exe", CommandLine: "powershell", Created: 100 },
        { ProcessId: 11, ParentProcessId: 10, Name: "node.exe", CommandLine: "node x.js", Created: 200 },
      ]),
    );
    expect(arr).toHaveLength(2);
    expect(arr[1]!.command).toBe("node.exe");
    expect(arr[1]!.created).toBe(200);

    const single = parseWindowsProcessList(
      JSON.stringify({ ProcessId: 5, ParentProcessId: 1, Name: "cmd.exe", CommandLine: null, Created: 1 }),
    );
    expect(single).toHaveLength(1);
    expect(single[0]!.args).toBe("");
  });

  test("selects a known agent anywhere in the tree", () => {
    const rows = parseWindowsProcessList(
      JSON.stringify([
        { ProcessId: 100, ParentProcessId: 1, Name: "powershell.exe", CommandLine: "powershell", Created: 1 },
        { ProcessId: 101, ParentProcessId: 100, Name: "node.exe", CommandLine: "node C:\\bin\\claude-code", Created: 2 },
      ]),
    );
    const active = selectActiveCommandWindows(rows, 100);
    expect(active?.agent).toBe("claude");
    expect(active?.pid).toBe(101);
  });

  test("picks the deepest, most-recent non-shell descendant", () => {
    const rows = parseWindowsProcessList(
      JSON.stringify([
        { ProcessId: 100, ParentProcessId: 1, Name: "powershell.exe", CommandLine: "pwsh", Created: 1 },
        { ProcessId: 101, ParentProcessId: 100, Name: "cmd.exe", CommandLine: "cmd", Created: 2 },
        { ProcessId: 102, ParentProcessId: 101, Name: "vim.exe", CommandLine: "vim a.txt", Created: 5 },
        { ProcessId: 103, ParentProcessId: 101, Name: "git.exe", CommandLine: "git status", Created: 9 },
      ]),
    );
    // 102 and 103 share depth 2; 103 is newer.
    const active = selectActiveCommandWindows(rows, 100);
    expect(active?.pid).toBe(103);
    expect(active?.command).toBe("git.exe");
  });

  test("omits metadata when only shells are present", () => {
    const rows = parseWindowsProcessList(
      JSON.stringify([
        { ProcessId: 100, ParentProcessId: 1, Name: "powershell.exe", CommandLine: "pwsh", Created: 1 },
        { ProcessId: 101, ParentProcessId: 100, Name: "cmd.exe", CommandLine: "cmd", Created: 2 },
      ]),
    );
    expect(selectActiveCommandWindows(rows, 100)).toBeUndefined();
  });

  test("omits metadata on unparseable CIM output (graceful degradation)", () => {
    expect(parseWindowsProcessList("not json")).toEqual([]);
  });
});
