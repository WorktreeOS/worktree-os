import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Ic } from "@/components/ui/inline-code";
import { useUiApi } from "@/lib/api-context";
import {
  UiForbiddenError,
  type TerminalBackendAvailability,
} from "@/lib/ui-api";
import { FormRow, Section, TextInput, useSettingsContext } from "../shared";

type AvailabilityState = {
  loading: boolean;
  data: TerminalBackendAvailability | null;
  error: string | null;
};

export function TerminalPage() {
  const { form, updateField, fieldError } = useSettingsContext();
  const api = useUiApi();
  const [availability, setAvailability] = useState<AvailabilityState>({
    loading: true,
    data: null,
    error: null,
  });

  const fetchAvailability = useCallback(async () => {
    setAvailability((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const res = await api.getTerminalBackendAvailability();
      setAvailability({ loading: false, data: res.tmux, error: null });
    } catch (e) {
      const message =
        e instanceof UiForbiddenError
          ? "Terminal backend availability is unavailable for this session."
          : (e as Error).message;
      setAvailability({ loading: false, data: null, error: message });
    }
  }, [api]);

  useEffect(() => {
    void fetchAvailability();
  }, [fetchAvailability]);

  const { loading, data, error } = availability;
  const available = data?.available === true;
  const checkboxDisabled = loading || !available;
  const savedTmuxUnavailable =
    form.terminalBackend === "tmux" && !loading && data !== null && !available;

  return (
    <Section title="Terminal" id="settings-section-terminal">
      <FormRow
        label="Backend"
        hint="Default keeps daemon-owned PTYs and ends them on restart. tmux persists sessions through the multiplexer so a daemon restart can restore them."
        error={fieldError("terminalBackend")}
      >
        <div className="flex flex-col gap-2">
          <Checkbox
            checked={form.terminalBackend === "tmux"}
            onCheckedChange={(v) =>
              updateField("terminalBackend", v ? "tmux" : "default")
            }
            disabled={checkboxDisabled}
            data-testid="settings-terminal-backend"
          >
            Persist sessions with tmux
          </Checkbox>

          {loading && (
            <p
              className="inline-flex items-center gap-1.5 text-[12.5px] text-[color:var(--muted-foreground)] m-0"
              data-testid="settings-terminal-availability-loading"
            >
              <Loader2 className="size-3 animate-spin" />
              Checking multiplexer availability…
            </p>
          )}

          {!loading && error && (
            <div
              className="flex flex-col gap-1.5"
              data-testid="settings-terminal-availability-error"
            >
              <p className="text-[12.5px] text-[color:var(--bad)] m-0">
                Could not check multiplexer availability: {error}
              </p>
              <CheckAgainButton onClick={fetchAvailability} loading={loading} />
            </div>
          )}

          {!loading && data && available && (
            <p
              className="inline-flex items-center gap-1.5 text-[12.5px] text-[color:var(--good)] m-0"
              data-testid="settings-terminal-available"
            >
              Detected multiplexer <Ic>{data.binary}</Ic>
            </p>
          )}

          {!loading && data && !available && (
            <TerminalInstallGuidance
              data={data}
              onCheckAgain={fetchAvailability}
              loading={loading}
            />
          )}

          {savedTmuxUnavailable && (
            <p
              className="text-[12.5px] text-[color:var(--warn)] m-0"
              data-testid="settings-terminal-saved-unavailable"
            >
              The saved tmux backend is currently unavailable on this host;
              terminal sessions will fall back until the multiplexer is
              installed.
            </p>
          )}
        </div>
      </FormRow>

      <FormRow
        label="Editor command"
        htmlFor="settings-editor-command"
        hint={'Command run to open a worktree in your editor. The worktree path is in $WOS_WORKTREE_PATH (recommended) or the {path} token. Example: code "$WOS_WORKTREE_PATH". Leave empty to disable.'}
        error={fieldError("editorCommand")}
      >
        <TextInput
          id="settings-editor-command"
          value={form.editorCommand}
          onChange={(v) => updateField("editorCommand", v)}
          placeholder={'code "$WOS_WORKTREE_PATH"'}
          data-testid="settings-editor-command"
        />
      </FormRow>

      <FormRow
        label="Agent plugins"
        hint="Automatically keep the wos activity plugins wired into Claude Code (user hooks) and OpenCode (plugin entry) so agent status, completion, and questions show up in the sidebar."
        error={fieldError("autoInjectAgentPlugins")}
      >
        <Checkbox
          checked={form.autoInjectAgentPlugins}
          onCheckedChange={(v) => updateField("autoInjectAgentPlugins", v)}
          data-testid="settings-auto-inject-agent-plugins"
        >
          Auto-inject
        </Checkbox>
      </FormRow>
    </Section>
  );
}

function CheckAgainButton({
  onClick,
  loading,
}: {
  onClick: () => void;
  loading: boolean;
}) {
  return (
    <Button
      type="button"
      variant="default"
      size="sm"
      onClick={onClick}
      disabled={loading}
      data-testid="settings-terminal-check-again"
    >
      {loading ? (
        <Loader2 className="size-[14px] animate-spin" />
      ) : (
        <RefreshCw className="size-[14px]" />
      )}
      Check again
    </Button>
  );
}

/**
 * Platform-aware install guidance shown when the multiplexer is unavailable.
 * Names psmux on Windows / tmux on POSIX, lists install commands as inline-code
 * chips, links an external install reference, and offers a re-check that does
 * not restart the daemon.
 */
function TerminalInstallGuidance({
  data,
  onCheckAgain,
  loading,
}: {
  data: TerminalBackendAvailability;
  onCheckAgain: () => void;
  loading: boolean;
}) {
  const isWindows = data.platform === "win32";
  const name = isWindows ? "psmux" : "tmux";
  const commands = isWindows
    ? ["winget install psmux", "scoop install psmux", "cargo install psmux"]
    : ["brew install tmux", "sudo apt-get install tmux"];
  const link = isWindows
    ? "https://crates.io/crates/psmux"
    : "https://github.com/tmux/tmux/wiki/Installing";
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="settings-terminal-unavailable"
    >
      <p className="text-[12.5px] text-[color:var(--ink-2)] m-0">
        {name} is required for the tmux backend but is not installed on this
        host (resolved binary <Ic>{data.binary}</Ic>). Install it, then re-check.
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {commands.map((cmd) => (
          <Ic key={cmd}>{cmd}</Ic>
        ))}
      </div>
      <div className="flex items-center gap-2.5">
        <CheckAgainButton onClick={onCheckAgain} loading={loading} />
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[12.5px] text-[color:var(--ink-2)] hover:text-[color:var(--ink)] transition-colors"
          data-testid="settings-terminal-install-link"
        >
          Install reference
          <ExternalLink className="size-[12px]" />
        </a>
      </div>
    </div>
  );
}
