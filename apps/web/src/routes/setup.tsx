import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, Check, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Document } from "@/routes/worktree/document";
import { Ic } from "@/components/ui/inline-code";
import { TodoBanner } from "@/components/ui/todo-banner";
import { useUiApi } from "@/lib/api-context";
import { useSetupGate } from "@/lib/setup-context";
import {
  UiApiError,
  UiValidationError,
  type AgentPluginsResponse,
  type SettingsConfigDraft,
  type SetupEnvironmentResponse,
  type SetupStatusResponse,
} from "@/lib/ui-api";

/* First-run onboarding gate. Renders a readiness checklist covering the first-run
 * essentials only — web port, Docker, Docker Compose v2, tmux/psmux, and agent
 * plugins — each with a per-item status and action. Finishing stamps the
 * completion marker and routes to the dashboard. Bind-host, tunnel, public Web
 * UI, and SSL are intentionally absent; they live only in Settings. */
export function SetupRoute() {
  const { state, refresh: refreshGate } = useSetupGate();
  if (state.kind === "loading") {
    return (
      <Document data-testid="setup-loading">
        <Document.Body>
          <div className="flex items-center gap-2 text-[color:var(--muted-foreground)] text-[13px]">
            <Loader2 className="size-3 animate-spin" />
            Loading setup…
          </div>
        </Document.Body>
      </Document>
    );
  }
  if (state.kind === "error") {
    return (
      <Document data-testid="setup-error">
        <Document.Body>
          <TodoBanner tone="failed">{state.message}</TodoBanner>
          <div className="mt-4">
            <Button size="sm" onClick={() => void refreshGate()}>
              Retry
            </Button>
          </div>
        </Document.Body>
      </Document>
    );
  }
  if (state.kind === "unavailable") {
    return <SetupUnavailable />;
  }
  return <OnboardingChecklist status={state.status} onComplete={() => void refreshGate()} />;
}

function SetupUnavailable() {
  return (
    <Document data-testid="setup-public-unavailable">
      <Document.Body>
        <div className="reveal flex flex-col items-center justify-center gap-4 py-16 text-center">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.3em] text-[color:var(--muted-foreground)]">
            unavailable
          </div>
          <h1 className="text-[20px] font-semibold tracking-tight">
            First-run setup is local-only
          </h1>
          <p className="max-w-md text-[14px] text-[color:var(--ink-2)]">
            Open this page directly on the machine running WorktreeOS to complete
            first-run onboarding.
          </p>
        </div>
      </Document.Body>
    </Document>
  );
}

/* ==================================================================== */

type EnvState =
  | { kind: "checking" }
  | { kind: "ready"; data: SetupEnvironmentResponse }
  | { kind: "error"; message: string };

type PluginsState =
  | { kind: "checking" }
  | { kind: "ready"; data: AgentPluginsResponse }
  | { kind: "error"; message: string };

function OnboardingChecklist({
  status,
  onComplete,
}: {
  status: SetupStatusResponse;
  onComplete: () => void;
}) {
  const api = useUiApi();
  const snapshot = status.globalConfig;

  const [env, setEnv] = useState<EnvState>({ kind: "checking" });
  const [plugins, setPlugins] = useState<PluginsState>({ kind: "checking" });
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  const refreshEnv = useCallback(async () => {
    setEnv({ kind: "checking" });
    try {
      const data = await api.getSetupEnvironment();
      setEnv({ kind: "ready", data });
    } catch (e) {
      setEnv({ kind: "error", message: (e as Error).message });
    }
  }, [api]);

  const refreshPlugins = useCallback(async () => {
    setPlugins({ kind: "checking" });
    try {
      const data = await api.getAgentPlugins();
      setPlugins({ kind: "ready", data });
    } catch (e) {
      setPlugins({ kind: "error", message: (e as Error).message });
    }
  }, [api]);

  useEffect(() => {
    void refreshEnv();
    void refreshPlugins();
  }, [refreshEnv, refreshPlugins]);

  const finish = useCallback(async () => {
    setFinishing(true);
    setFinishError(null);
    try {
      await api.markSetupComplete();
      onComplete();
    } catch (e) {
      setFinishError((e as Error).message);
      setFinishing(false);
    }
  }, [api, onComplete]);

  // Port-changed notice: the daemon is being served on a different port than the
  // configured/default one (free-port fallback on a busy port). Compare the port
  // the browser actually reached against the configured effective port.
  const configuredPort = snapshot.effective.web.port;
  const actualPort =
    typeof window !== "undefined" && window.location.port
      ? Number(window.location.port)
      : undefined;
  const portChanged =
    actualPort !== undefined && Number.isFinite(actualPort) && actualPort !== configuredPort;

  return (
    <Document data-testid="setup-page">
      <Document.Head
        title={<span>Welcome to WorktreeOS</span>}
        status={<span>First-run onboarding</span>}
      />
      <Document.Body>
        <p className="reveal text-[14px] text-[color:var(--ink-2)] m-0 mb-4">
          Get your environment ready. Each item can be actioned now or later from
          Settings — nothing here blocks you from finishing.
        </p>

        {portChanged && (
          <div className="reveal mb-4">
            <TodoBanner tone="idle" data-testid="setup-port-changed">
              The configured port <Ic>{String(configuredPort)}</Ic> was busy, so the
              daemon is running on <Ic>{String(actualPort)}</Ic>. Update the web port
              below to make it permanent.
            </TodoBanner>
          </div>
        )}

        <ol
          className="reveal list-none m-0 p-0 flex flex-col divide-y divide-[color:var(--hair)] border-y border-[color:var(--hair)]"
          data-testid="setup-checklist"
        >
          <PortItem snapshot={snapshot} />
          <DockerItem env={env} onRefresh={refreshEnv} />
          <ComposeItem env={env} onRefresh={refreshEnv} />
          <TmuxItem env={env} onRefresh={refreshEnv} />
          <PluginsItem plugins={plugins} onRefresh={refreshPlugins} />
        </ol>

        {finishError && (
          <div className="mt-4">
            <TodoBanner tone="failed" data-testid="setup-finish-error">
              {finishError}
            </TodoBanner>
          </div>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-2.5">
          <Button
            variant="solid"
            size="md"
            onClick={() => void finish()}
            disabled={finishing}
            data-testid="setup-finish"
          >
            {finishing ? (
              <>
                <Loader2 className="size-[14px] animate-spin" /> Finishing…
              </>
            ) : (
              "Finish onboarding"
            )}
          </Button>
          <span className="text-[12.5px] text-[color:var(--muted-foreground)]">
            Add your first project from the sidebar once you finish.
          </span>
        </div>
      </Document.Body>
    </Document>
  );
}

/* ==================================================================== */

type ItemTone = "satisfied" | "pending" | "failed" | "checking";

function ChecklistItem({
  title,
  statusWord,
  tone,
  description,
  action,
  testId,
}: {
  title: string;
  statusWord: string;
  tone: ItemTone;
  description?: ReactNode;
  action?: ReactNode;
  testId: string;
}) {
  const wordColor =
    tone === "satisfied"
      ? "var(--good)"
      : tone === "failed"
        ? "var(--bad)"
        : "var(--muted-foreground)";
  return (
    <li className="grid gap-2 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start" data-testid={testId}>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <ItemGlyph tone={tone} />
          <span className="text-[14px] font-semibold text-[color:var(--ink)]">
            {title}
          </span>
          <span
            className="text-[12.5px]"
            style={{ color: `color-mix(in oklch, ${wordColor} 92%, transparent)` }}
            data-testid={`${testId}-status`}
          >
            {statusWord}
          </span>
        </div>
        {description && (
          <div className="text-[12.5px] text-[color:var(--muted-foreground)] pl-[26px]">
            {description}
          </div>
        )}
      </div>
      {action && <div className="flex items-center gap-2 md:justify-end">{action}</div>}
    </li>
  );
}

function ItemGlyph({ tone }: { tone: ItemTone }) {
  if (tone === "checking") {
    return <Loader2 className="size-[15px] shrink-0 animate-spin text-[color:var(--muted-foreground)]" />;
  }
  if (tone === "satisfied") {
    return <Check className="size-[15px] shrink-0 text-[color:var(--good)]" />;
  }
  if (tone === "failed") {
    return <AlertCircle className="size-[15px] shrink-0 text-[color:var(--bad)]" />;
  }
  return (
    <span className="grid size-[15px] shrink-0 place-items-center">
      <span className="size-[7px] rounded-full border border-[color:var(--hair-2)]" />
    </span>
  );
}

function RefreshButton({ onClick, label }: { onClick: () => void; label?: string }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} data-testid="setup-refresh">
      <RefreshCw className="size-[14px]" />
      {label ?? "Refresh"}
    </Button>
  );
}

/* -------- Web port -------- */
function PortItem({ snapshot }: { snapshot: SetupStatusResponse["globalConfig"] }) {
  const api = useUiApi();
  const raw = snapshot.raw ?? {};
  const [port, setPort] = useState<string>(
    String(raw.web?.port ?? snapshot.effective.web.port),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const draft: SettingsConfigDraft = {};
      const parsed = parseInt(port.trim(), 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        setError("Port must be an integer in [1, 65535]");
        setSaving(false);
        return;
      }
      draft.web = { port: parsed };
      const res = await api.saveSettingsConfig(draft);
      setSaved(true);
      setRestartRequired(res.restartRequired === true);
    } catch (e) {
      if (e instanceof UiValidationError) {
        setError(e.fieldErrors[0]?.message ?? e.message);
      } else if (e instanceof UiApiError) {
        setError(e.message);
      } else {
        setError((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }, [api, port]);

  return (
    <ChecklistItem
      testId="setup-item-port"
      title="Web port"
      statusWord={saved ? "saved" : "optional"}
      tone={saved ? "satisfied" : "pending"}
      description={
        error ? (
          <span className="text-[color:var(--bad)]" data-testid="setup-item-port-error">
            {error}
          </span>
        ) : restartRequired ? (
          <span data-testid="setup-item-port-restart">
            Saved. Restart the daemon for the new port to take effect.
          </span>
        ) : (
          "HTTP port the daemon serves the local web UI on."
        )
      }
      action={
        <>
          <input
            type="number"
            value={port}
            onChange={(e) => {
              setPort(e.target.value);
              setSaved(false);
            }}
            data-testid="setup-web-port"
            className="w-[120px] rounded-md border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-2.5 py-1.5 text-[13.5px] text-[color:var(--ink)] outline-none focus-visible:border-[color:var(--ink)]/40"
          />
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={saving}
            data-testid="setup-web-port-save"
          >
            {saving ? <Loader2 className="size-[14px] animate-spin" /> : "Save"}
          </Button>
        </>
      }
    />
  );
}

/* -------- Docker + Compose (shared env probe) -------- */
function DockerItem({ env, onRefresh }: { env: EnvState; onRefresh: () => void }) {
  const installed = env.kind === "ready" ? env.data.docker.installed : false;
  const tone: ItemTone =
    env.kind === "checking"
      ? "checking"
      : env.kind === "error"
        ? "failed"
        : installed
          ? "satisfied"
          : "failed";
  return (
    <ChecklistItem
      testId="setup-item-docker"
      title="Docker"
      statusWord={
        env.kind === "checking"
          ? "checking…"
          : env.kind === "error"
            ? "probe failed"
            : installed
              ? "installed"
              : "not found"
      }
      tone={tone}
      description={
        env.kind === "error" ? (
          env.message
        ) : installed ? (
          "Required to deploy worktree services (wos up)."
        ) : (
          <span>
            Install Docker Desktop or Docker Engine —{" "}
            <a
              className="underline text-[color:var(--ink)]"
              href="https://docs.docker.com/get-docker/"
              target="_blank"
              rel="noreferrer"
            >
              docs.docker.com/get-docker
            </a>
            , then refresh.
          </span>
        )
      }
      action={<RefreshButton onClick={onRefresh} />}
    />
  );
}

function ComposeItem({ env, onRefresh }: { env: EnvState; onRefresh: () => void }) {
  const installed = env.kind === "ready" ? env.data.dockerCompose.installed : false;
  const tone: ItemTone =
    env.kind === "checking"
      ? "checking"
      : env.kind === "error"
        ? "failed"
        : installed
          ? "satisfied"
          : "failed";
  return (
    <ChecklistItem
      testId="setup-item-compose"
      title="Docker Compose v2"
      statusWord={
        env.kind === "checking"
          ? "checking…"
          : env.kind === "error"
            ? "probe failed"
            : installed
              ? "available"
              : "not found"
      }
      tone={tone}
      description={
        env.kind === "error" ? (
          env.message
        ) : installed ? (
          <span>
            <Ic>docker compose</Ic> v2 is usable.
          </span>
        ) : (
          <span>
            Install the Docker Compose plugin —{" "}
            <a
              className="underline text-[color:var(--ink)]"
              href="https://docs.docker.com/compose/install/"
              target="_blank"
              rel="noreferrer"
            >
              docs.docker.com/compose/install
            </a>
            , then refresh.
          </span>
        )
      }
      action={<RefreshButton onClick={onRefresh} />}
    />
  );
}

/* -------- tmux / psmux (install action) -------- */
function TmuxItem({ env, onRefresh }: { env: EnvState; onRefresh: () => void }) {
  const api = useUiApi();
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<
    | null
    | { kind: "manual"; command: string; message?: string }
    | { kind: "error"; message: string }
  >(null);

  const available = env.kind === "ready" ? env.data.tmux.available : false;
  const pkg = env.kind === "ready" ? env.data.tmux.packageManager : null;

  const install = useCallback(async () => {
    setInstalling(true);
    setResult(null);
    try {
      const res = await api.installTmux();
      if (res.status === "ok") {
        onRefresh();
      } else if (res.status === "manual-required") {
        setResult({
          kind: "manual",
          command: res.command ?? "",
          ...(res.message ? { message: res.message } : {}),
        });
      } else {
        setResult({ kind: "error", message: res.message ?? "tmux install failed" });
      }
    } catch (e) {
      setResult({ kind: "error", message: (e as Error).message });
    } finally {
      setInstalling(false);
    }
  }, [api, onRefresh]);

  const tone: ItemTone = installing
    ? "checking"
    : env.kind === "checking"
      ? "checking"
      : available
        ? "satisfied"
        : "pending";

  return (
    <ChecklistItem
      testId="setup-item-tmux"
      title="tmux / psmux"
      statusWord={
        installing
          ? "installing…"
          : env.kind === "checking"
            ? "checking…"
            : available
              ? "available"
              : "recommended"
      }
      tone={tone}
      description={
        available ? (
          "Stable terminal sessions are backed by the tmux multiplexer."
        ) : result?.kind === "manual" ? (
          <span data-testid="setup-item-tmux-manual">
            Run <Ic>{result.command}</Ic> in a terminal, then refresh.
          </span>
        ) : result?.kind === "error" ? (
          <span className="text-[color:var(--bad)]" data-testid="setup-item-tmux-error">
            {result.message}
          </span>
        ) : pkg ? (
          <span>
            Not installed. Install with <Ic>{pkg.command}</Ic>
            {pkg.requiresElevation ? " (needs sudo)." : "."}
          </span>
        ) : (
          "Not installed and no supported package manager was detected — install tmux manually, then refresh."
        )
      }
      action={
        available ? (
          <RefreshButton onClick={onRefresh} />
        ) : (
          <>
            {pkg && (
              <Button
                size="sm"
                onClick={() => void install()}
                disabled={installing}
                data-testid="setup-item-tmux-install"
              >
                {installing ? <Loader2 className="size-[14px] animate-spin" /> : "Install"}
              </Button>
            )}
            <RefreshButton onClick={onRefresh} />
          </>
        )
      }
    />
  );
}

/* -------- Agent plugins -------- */
function PluginsItem({
  plugins,
  onRefresh,
}: {
  plugins: PluginsState;
  onRefresh: () => void;
}) {
  const api = useUiApi();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data = plugins.kind === "ready" ? plugins.data : null;
  const installedCount = data
    ? [data.claude.installed, data.opencode.installed, data.codex.installed, data.pi.installed].filter(
        Boolean,
      ).length
    : 0;
  const anyInstalled = installedCount > 0;

  const install = useCallback(async () => {
    setInstalling(true);
    setError(null);
    try {
      await api.installAgentPlugins();
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInstalling(false);
    }
  }, [api, onRefresh]);

  const tone: ItemTone = installing
    ? "checking"
    : plugins.kind === "checking"
      ? "checking"
      : plugins.kind === "error"
        ? "failed"
        : anyInstalled
          ? "satisfied"
          : "pending";

  return (
    <ChecklistItem
      testId="setup-item-plugins"
      title="Agent plugins"
      statusWord={
        installing
          ? "installing…"
          : plugins.kind === "checking"
            ? "checking…"
            : plugins.kind === "error"
              ? "probe failed"
              : anyInstalled
                ? `${installedCount} installed`
                : "recommended"
      }
      tone={tone}
      description={
        plugins.kind === "error" ? (
          plugins.message
        ) : error ? (
          <span className="text-[color:var(--bad)]" data-testid="setup-item-plugins-error">
            {error}
          </span>
        ) : (
          "Wire agent activity reporting for Claude Code, OpenCode, Codex, and pi."
        )
      }
      action={
        <>
          <Button
            size="sm"
            onClick={() => void install()}
            disabled={installing}
            data-testid="setup-item-plugins-install"
          >
            {installing ? <Loader2 className="size-[14px] animate-spin" /> : "Install"}
          </Button>
          <RefreshButton onClick={onRefresh} />
        </>
      }
    />
  );
}
