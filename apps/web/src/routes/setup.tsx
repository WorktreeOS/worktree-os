import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  Check,
  Folder,
  GitBranch,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Document } from "@/routes/worktree/document";
import { Ic } from "@/components/ui/inline-code";
import { TodoBanner } from "@/components/ui/todo-banner";
import { useUiApi } from "@/lib/api-context";
import { useSetupGate } from "@/lib/setup-context";
import {
  UiApiError,
  UiValidationError,
  type DirectoryListResponse,
  type DirectorySuggestion,
  type SettingsConfigDraft,
  type SettingsConfigSnapshot,
  type SettingsValidationFieldError,
} from "@/lib/ui-api";
import {
  deriveDirPath,
  deriveQuery,
  filterSuggestions,
  normalizeForValidation,
  parentDirOf,
} from "@/lib/add-project-logic";
import { cn } from "@/lib/utils";

/* First-run setup gate. Renders a focused 2-step flow:
 *   1. Optional global settings (web port, public access, tunneling).
 *      Saving creates `<wos-home>/config.json` and marks restart-required.
 *   2. Register the first project by absolute Git worktree path.
 * After project registration succeeds the gate re-queries setup status and
 * the normal dashboard takes over. */
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
  return (
    <SetupFlow
      snapshot={state.status.globalConfig}
      onComplete={() => void refreshGate()}
    />
  );
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
            Open this page directly on the machine running WorktreeOS to register
            the first project and configure global settings.
          </p>
        </div>
      </Document.Body>
    </Document>
  );
}

type StepId = "settings" | "project";

function SetupFlow({
  snapshot,
  onComplete,
}: {
  snapshot: SettingsConfigSnapshot;
  onComplete: () => void;
}) {
  const [step, setStep] = useState<StepId>("settings");
  const [restartRequired, setRestartRequired] = useState(false);
  const [missingConfigNotice, setMissingConfigNotice] = useState<
    null | { path: string }
  >(null);

  return (
    <Document data-testid="setup-page">
      <Document.Head
        title={<span>Welcome to WorktreeOS</span>}
        status={<span>Local first-run setup</span>}
      />
      <Document.Body>
        <div className="reveal mb-3">
          <SetupSteps current={step} />
        </div>
        {step === "settings" && (
          <SettingsStep
            snapshot={snapshot}
            onContinue={(opts) => {
              setRestartRequired(opts.restartRequired);
              setStep("project");
            }}
          />
        )}
        {step === "project" && (
          <ProjectStep
            restartRequired={restartRequired}
            missingConfigNotice={missingConfigNotice}
            onMissingConfig={(path) => setMissingConfigNotice({ path })}
            onBack={() => setStep("settings")}
            onComplete={onComplete}
          />
        )}
      </Document.Body>
    </Document>
  );
}

function SetupSteps({ current }: { current: StepId }) {
  return (
    <ol
      className="list-none m-0 p-0 flex flex-wrap items-center gap-2 text-[12.5px] text-[color:var(--muted-foreground)]"
      data-testid="setup-steps"
    >
      <Step active={current === "settings"} done={current === "project"} index="1">
        Global settings
      </Step>
      <span className="text-[color:var(--muted-foreground)]/50">·</span>
      <Step active={current === "project"} done={false} index="2">
        First project
      </Step>
    </ol>
  );
}

function Step({
  active,
  done,
  index,
  children,
}: {
  active: boolean;
  done: boolean;
  index: string;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "inline-flex items-center gap-1.5",
        active && "text-[color:var(--ink)] font-medium",
      )}
    >
      <span
        className={cn(
          "grid place-items-center size-[18px] rounded-full font-mono text-[11px] border",
          done
            ? "bg-[color:var(--ink)] text-[color:var(--surface)] border-[color:var(--ink)]"
            : active
              ? "border-[color:var(--ink)] text-[color:var(--ink)]"
              : "border-[color:var(--hair-2)]",
        )}
      >
        {done ? <Check className="size-[11px]" /> : index}
      </span>
      <span>{children}</span>
    </li>
  );
}

/* ====================================================================
 * Step 1 — Global settings (web port + public access + tunnel).
 *   The full settings page covers everything; this step keeps the
 *   first-run scope tight while still reusing the same save endpoint.
 * ==================================================================== */
function SettingsStep({
  snapshot,
  onContinue,
}: {
  snapshot: SettingsConfigSnapshot;
  onContinue: (opts: { restartRequired: boolean }) => void;
}) {
  const api = useUiApi();
  const eff = snapshot.effective;
  const raw = snapshot.raw ?? {};
  const [webPort, setWebPort] = useState<string>(
    String(raw.web?.port ?? eff.web.port),
  );
  const [tunnelWebUiEnabled, setTunnelWebUiEnabled] = useState<boolean>(
    raw.tunnel?.webUi?.enabled ?? eff.tunnel.webUi.enabled,
  );
  const [tunnelWebUiSubdomain, setTunnelWebUiSubdomain] = useState<string>(
    raw.tunnel?.webUi?.subdomain ??
      (eff.tunnel.webUi.enabled ? eff.tunnel.webUi.hostname : ""),
  );
  const [tunnelWebUiSecret, setTunnelWebUiSecret] = useState<string>(
    raw.tunnel?.webUi?.secret ??
      (eff.tunnel.webUi.enabled ? eff.tunnel.webUi.secret : ""),
  );
  const [tunnelEnabled, setTunnelEnabled] = useState<boolean>(
    raw.tunnel?.enabled ?? eff.tunnel.enabled,
  );
  const [tunnelDomain, setTunnelDomain] = useState<string>(
    raw.tunnel?.domain ?? (eff.tunnel.enabled ? eff.tunnel.domain : ""),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<SettingsValidationFieldError[]>([]);

  const fieldError = useCallback(
    (field: string) => fieldErrors.find((e) => e.field === field)?.message,
    [fieldErrors],
  );

  const buildDraft = useCallback((): SettingsConfigDraft => {
    const draft: SettingsConfigDraft = {};
    const web: NonNullable<SettingsConfigDraft["web"]> = {};
    const port = parseInt(webPort.trim(), 10);
    if (Number.isFinite(port)) web.port = port;
    draft.web = web;
    const tunnel: NonNullable<SettingsConfigDraft["tunnel"]> = {
      enabled: tunnelEnabled,
    };
    if (tunnelDomain.trim().length > 0) tunnel.domain = tunnelDomain.trim();
    const webUi: NonNullable<NonNullable<SettingsConfigDraft["tunnel"]>["webUi"]> = {
      enabled: tunnelWebUiEnabled,
    };
    if (tunnelWebUiSubdomain.trim().length > 0) {
      webUi.subdomain = tunnelWebUiSubdomain.trim();
    }
    if (tunnelWebUiSecret.length > 0) webUi.secret = tunnelWebUiSecret;
    tunnel.webUi = webUi;
    draft.tunnel = tunnel;
    return draft;
  }, [
    tunnelDomain,
    tunnelEnabled,
    tunnelWebUiEnabled,
    tunnelWebUiSubdomain,
    tunnelWebUiSecret,
    webPort,
  ]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setFieldErrors([]);
    try {
      const res = await api.saveSettingsConfig(buildDraft());
      onContinue({ restartRequired: res.restartRequired === true });
    } catch (e) {
      if (e instanceof UiValidationError) {
        setFieldErrors(e.fieldErrors);
        setSaveError(e.message);
      } else if (e instanceof UiApiError) {
        setSaveError(e.message);
      } else {
        setSaveError((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }, [api, buildDraft, onContinue]);

  const skip = useCallback(() => {
    onContinue({ restartRequired: false });
  }, [onContinue]);

  return (
    <Document.Section title="Global settings">
      <p className="text-[14px] text-[color:var(--ink-2)] m-0 mb-3">
        Save these now to create <Ic>{snapshot.path}</Ic>, or skip to use the
        built-in defaults. You can edit everything later in Settings.
      </p>
      {saveError && (
        <TodoBanner tone="failed" data-testid="setup-settings-error">
          {saveError}
        </TodoBanner>
      )}
      <div className="flex flex-col divide-y divide-[color:var(--hair)] border-y border-[color:var(--hair)]">
        <FormRow
          label="Web port"
          htmlFor="setup-web-port"
          hint="HTTP port the daemon listens on for the local web UI."
          error={fieldError("web.port")}
        >
          <NumberInput
            id="setup-web-port"
            value={webPort}
            onChange={setWebPort}
            placeholder="4949"
            data-testid="setup-web-port"
          />
        </FormRow>
        <FormRow label="Tunnel" hint="Required to expose worktree services on public subdomains.">
          <Checkbox
            checked={tunnelEnabled}
            onCheckedChange={setTunnelEnabled}
            data-testid="setup-tunnel-enabled"
          >
            Enabled
          </Checkbox>
        </FormRow>
        <FormRow
          label="Tunnel domain"
          htmlFor="setup-tunnel-domain"
          muted={!tunnelEnabled}
          error={fieldError("tunnel.domain")}
        >
          <TextInput
            id="setup-tunnel-domain"
            value={tunnelDomain}
            onChange={setTunnelDomain}
            placeholder="example.com"
            data-testid="setup-tunnel-domain"
          />
        </FormRow>
        <FormRow
          label="Public Web UI"
          muted={!tunnelEnabled}
          hint="Publish the management Web UI through the tunnel listener under a subdomain of tunnel.domain."
        >
          <Checkbox
            checked={tunnelWebUiEnabled}
            onCheckedChange={setTunnelWebUiEnabled}
            data-testid="setup-tunnel-webui-enabled"
          >
            Enabled
          </Checkbox>
        </FormRow>
        <FormRow
          label="Web UI subdomain"
          htmlFor="setup-tunnel-webui-subdomain"
          muted={!tunnelEnabled || !tunnelWebUiEnabled}
          error={fieldError("tunnel.webUi.subdomain")}
          hint="DNS label or full hostname under tunnel.domain."
        >
          <TextInput
            id="setup-tunnel-webui-subdomain"
            value={tunnelWebUiSubdomain}
            onChange={setTunnelWebUiSubdomain}
            placeholder="wos"
            data-testid="setup-tunnel-webui-subdomain"
          />
        </FormRow>
        <FormRow
          label="Web UI secret"
          htmlFor="setup-tunnel-webui-secret"
          muted={!tunnelEnabled || !tunnelWebUiEnabled}
          error={fieldError("tunnel.webUi.secret")}
        >
          <TextInput
            id="setup-tunnel-webui-secret"
            value={tunnelWebUiSecret}
            onChange={setTunnelWebUiSecret}
            placeholder="secret…"
            data-testid="setup-tunnel-webui-secret"
          />
        </FormRow>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <Button
          variant="solid"
          size="md"
          onClick={handleSave}
          disabled={saving}
          data-testid="setup-settings-save"
        >
          {saving ? (
            <>
              <Loader2 className="size-[14px] animate-spin" /> Saving…
            </>
          ) : (
            "Save and continue"
          )}
        </Button>
        <Button
          variant="ghost"
          size="md"
          onClick={skip}
          disabled={saving}
          data-testid="setup-settings-skip"
        >
          Skip — use defaults
        </Button>
      </div>
    </Document.Section>
  );
}

/* ====================================================================
 * Step 2 — Register the first project via the existing add-project flow.
 * ==================================================================== */
function ProjectStep({
  restartRequired,
  missingConfigNotice,
  onMissingConfig,
  onBack,
  onComplete,
}: {
  restartRequired: boolean;
  missingConfigNotice: { path: string } | null;
  onMissingConfig: (path: string) => void;
  onBack: () => void;
  onComplete: () => void;
}) {
  const api = useUiApi();
  const [input, setInput] = useState("/");
  const [open, setOpen] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitWarning, setSubmitWarning] = useState<string | null>(null);
  const [registered, setRegistered] = useState<{
    sourcePath: string;
    hasConfig: boolean;
  } | null>(null);
  const [directory, setDirectory] = useState<{
    path: string;
    entries: DirectorySuggestion[];
    loading: boolean;
    error: string | null;
  }>({ path: "", entries: [], loading: false, error: null });

  const inputRef = useRef<HTMLInputElement | null>(null);
  const dirRequestId = useRef(0);
  const dirPath = useMemo(() => deriveDirPath(input), [input]);
  const query = useMemo(
    () => deriveQuery(input, directory.path),
    [input, directory.path],
  );
  const visibleEntries = useMemo(
    () => filterSuggestions(directory.entries, query),
    [directory.entries, query],
  );

  useEffect(() => {
    if (!dirPath) {
      setDirectory({ path: "", entries: [], loading: false, error: null });
      return;
    }
    const requestId = ++dirRequestId.current;
    setDirectory((prev) => {
      const keep =
        prev.path === dirPath || prev.path === parentDirOf(dirPath);
      return {
        path: prev.path,
        entries: keep ? prev.entries : [],
        loading: true,
        error: null,
      };
    });
    let cancelled = false;
    (async () => {
      try {
        const res: DirectoryListResponse = await api.listDirectories(dirPath);
        if (cancelled || requestId !== dirRequestId.current) return;
        setDirectory({
          path: res.path,
          entries: res.entries,
          loading: false,
          error: null,
        });
        setActiveIndex(0);
      } catch (e) {
        if (cancelled || requestId !== dirRequestId.current) return;
        setDirectory({
          path: dirPath,
          entries: [],
          loading: false,
          error: (e as Error).message,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, dirPath]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const acceptSuggestion = (entry: DirectorySuggestion) => {
    setInput(entry.path.endsWith("/") ? entry.path : `${entry.path}/`);
    setOpen(true);
    setActiveIndex(0);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && visibleEntries.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (i + 1) % visibleEntries.length);
      return;
    }
    if (e.key === "ArrowUp" && visibleEntries.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) =>
        i <= 0 ? visibleEntries.length - 1 : i - 1,
      );
      return;
    }
    if (e.key === "Enter" && open && visibleEntries.length > 0) {
      e.preventDefault();
      const entry = visibleEntries[activeIndex] ?? visibleEntries[0]!;
      acceptSuggestion(entry);
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = normalizeForValidation(input);
    if (trimmed.length === 0) {
      setSubmitError("Provide an absolute path");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setSubmitWarning(null);
    try {
      const validation = await api.validateProjectPath(trimmed);
      if (!validation.valid) {
        setSubmitError(validation.message ?? "Path is not a Git worktree");
        setSubmitting(false);
        return;
      }
      if (validation.warning) setSubmitWarning(validation.warning.message);
      const added = await api.addProject({ path: trimmed });
      const sourcePath = added.project.sourcePath;
      const hasConfig = validation.warning?.code !== "missing-config";
      setRegistered({ sourcePath, hasConfig });
      if (!hasConfig) onMissingConfig(sourcePath);
    } catch (e) {
      setSubmitError(
        e instanceof UiApiError ? e.message : (e as Error).message,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const finish = () => onComplete();

  if (registered) {
    return (
      <Document.Section title="Project registered">
        {restartRequired && (
          <TodoBanner tone="idle" data-testid="setup-restart-required">
            Settings saved. Restart the WorktreeOS daemon for global config changes
            to take effect.
          </TodoBanner>
        )}
        {!registered.hasConfig && (
          <TodoBanner tone="failed" data-testid="setup-missing-config">
            <span>
              A project deploy config is missing under{" "}
              <Ic>{missingConfigNotice?.path ?? registered.sourcePath}</Ic>. Add{" "}
              <Ic>.wos/deploy.yaml</Ic> (and <Ic>.wos/deploy.worktree.yaml</Ic>{" "}
              for secondary worktrees) before starting any worktree.{" "}
              <a
                href="/docs/deploy-config"
                className="underline text-[color:var(--ink)]"
                data-testid="setup-docs-link"
              >
                Read the deploy config docs
              </a>
              .
            </span>
          </TodoBanner>
        )}
        {registered.hasConfig && (
          <TodoBanner tone="done" data-testid="setup-project-added">
            Registered <Ic>{registered.sourcePath}</Ic>. You can now open it
            from the sidebar.
          </TodoBanner>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <Button
            variant="solid"
            size="md"
            onClick={finish}
            data-testid="setup-finish"
          >
            Open dashboard
          </Button>
        </div>
      </Document.Section>
    );
  }

  return (
    <Document.Section title="First project">
      <p className="text-[14px] text-[color:var(--ink-2)] m-0 mb-3">
        Point WorktreeOS at an existing Git worktree. The primary worktree is
        registered and every sibling appears in the sidebar automatically.
      </p>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label htmlFor="setup-project-path" className="flex flex-col gap-1.5">
          <span className="font-mono text-[12px] text-[color:var(--muted-foreground)]">
            path
          </span>
          <div className="flex items-center gap-2 rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-3 py-2 focus-within:ring-1 focus-within:ring-[color:var(--ink)]/30">
            <Folder className="h-3.5 w-3.5 text-[color:var(--muted-foreground)]" />
            <input
              ref={inputRef}
              id="setup-project-path"
              type="text"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setOpen(true);
                setSubmitError(null);
                setSubmitWarning(null);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
              placeholder="/path/to/repo"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              disabled={submitting}
              className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-[color:var(--ink)] placeholder:text-[color:var(--muted-foreground)] focus:outline-none"
              data-testid="setup-project-path-input"
            />
            {directory.loading && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-[color:var(--muted-foreground)]" />
            )}
          </div>
        </label>
        {open && (
          <SuggestionList
            dirPath={directory.path}
            loading={directory.loading}
            error={directory.error}
            entries={visibleEntries}
            activeIndex={activeIndex}
            onSelect={acceptSuggestion}
            onHover={setActiveIndex}
          />
        )}
        {submitWarning && !submitError && (
          <div
            className="flex items-start gap-2 rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--chip-bg)] px-3 py-2 text-[13px] text-[color:var(--ink-2)]"
            data-testid="setup-project-warning"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--warn)]" />
            <span>{submitWarning}</span>
          </div>
        )}
        {submitError && (
          <div
            className="flex items-start gap-2 rounded-[8px] border border-[color:var(--bad-border)] bg-[color:var(--bad-soft)] px-3 py-2 text-[13px] text-[color:var(--bad)]"
            data-testid="setup-project-error"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{submitError}</span>
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2.5">
          <Button
            type="submit"
            variant="solid"
            size="md"
            disabled={submitting || normalizeForValidation(input).length === 0}
            data-testid="setup-project-submit"
          >
            {submitting ? (
              <>
                <Loader2 className="size-[14px] animate-spin" /> Registering…
              </>
            ) : (
              "Register project"
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="md"
            onClick={onBack}
            disabled={submitting}
            data-testid="setup-project-back"
          >
            Back to settings
          </Button>
        </div>
      </form>
    </Document.Section>
  );
}

function SuggestionList({
  dirPath,
  loading,
  error,
  entries,
  activeIndex,
  onSelect,
  onHover,
}: {
  dirPath: string;
  loading: boolean;
  error: string | null;
  entries: DirectorySuggestion[];
  activeIndex: number;
  onSelect: (entry: DirectorySuggestion) => void;
  onHover: (index: number) => void;
}) {
  if (!dirPath) return null;
  if (error) {
    return (
      <div className="h-[200px] overflow-auto rounded-[8px] border border-[color:var(--bad-border)] bg-[color:var(--bad-soft)] px-3 py-2 text-[13px] text-[color:var(--bad)]">
        {error}
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="h-[200px] overflow-auto rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-3 py-2 text-[13px] text-[color:var(--muted-foreground)]">
        {loading ? "Loading suggestions..." : `No directories under ${dirPath}`}
      </div>
    );
  }
  return (
    <ul
      role="listbox"
      className="h-[200px] overflow-auto rounded-[8px] border border-[color:var(--hair-2)] bg-[color:var(--surface)] list-none m-0 p-0"
    >
      {entries.map((entry, index) => {
        const isActive = index === activeIndex;
        return (
          <li
            key={entry.path}
            role="option"
            aria-selected={isActive}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(entry);
            }}
            onMouseEnter={() => onHover(index)}
            className={cn(
              "flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px]",
              isActive
                ? "bg-[color:var(--hover)] text-[color:var(--ink)]"
                : "text-[color:var(--ink-2)] hover:bg-[color:var(--hover)]",
            )}
          >
            {entry.isGitWorktree ? (
              <GitBranch className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-[color:var(--muted-foreground)]" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono">
              {entry.name}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function FormRow({
  label,
  htmlFor,
  hint,
  error,
  muted,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid gap-2 py-3.5 md:grid-cols-[200px_minmax(0,1fr)] md:items-start",
        muted && "opacity-60",
      )}
    >
      <label
        htmlFor={htmlFor}
        className="text-[13.5px] font-medium text-[color:var(--ink)] pt-1"
      >
        {label}
      </label>
      <div className="flex flex-col gap-1.5">
        {children}
        {hint && (
          <p className="text-[12.5px] text-[color:var(--muted-foreground)] m-0">
            {hint}
          </p>
        )}
        {error && (
          <p className="text-[12.5px] text-[color:var(--bad)] m-0">{error}</p>
        )}
      </div>
    </div>
  );
}

function TextInput({
  id,
  value,
  onChange,
  placeholder,
  "data-testid": testId,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  "data-testid"?: string;
}) {
  return (
    <input
      id={id}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      data-testid={testId}
      className="w-full max-w-md rounded-md border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-2.5 py-1.5 text-[13.5px] text-[color:var(--ink)] outline-none focus-visible:border-[color:var(--ink)]/40 focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_oklch,var(--ink)_18%,transparent)]"
    />
  );
}

function NumberInput(props: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  "data-testid"?: string;
}) {
  return (
    <input
      id={props.id}
      type="number"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      placeholder={props.placeholder}
      data-testid={props["data-testid"]}
      className="w-full max-w-[200px] rounded-md border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-2.5 py-1.5 text-[13.5px] text-[color:var(--ink)] outline-none focus-visible:border-[color:var(--ink)]/40 focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_oklch,var(--ink)_18%,transparent)]"
    />
  );
}
