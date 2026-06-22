import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  NavLink,
  Outlet,
  useNavigate,
  useOutletContext,
} from "react-router";
import { ArrowLeft, Check, Loader2, RefreshCw } from "lucide-react";
import type { SidebarOutletContext } from "@/routes/layout";
import { SidebarToggle } from "@/components/ui/sidebar-toggle";
import { Document } from "@/routes/worktree/document";
import { Button } from "@/components/ui/button";
import { Ic } from "@/components/ui/inline-code";
import { TodoBanner } from "@/components/ui/todo-banner";
import { DaemonRestartModal } from "@/components/daemon-restart-modal";
import { useUiApi } from "@/lib/api-context";
import { usePublicAuth } from "@/lib/public-auth-context";
import { shouldRenderSettingsUnavailable } from "@/lib/settings-access";
import {
  UiApiError,
  UiForbiddenError,
  UiValidationError,
  type SettingsConfigResponse,
  type SettingsConfigSnapshot,
  type SettingsValidationFieldError,
} from "@/lib/ui-api";
import { cn } from "@/lib/utils";
import {
  buildDraft,
  emptyAiProvider,
  fieldKeyMatches,
  formStateFromSnapshot,
  type AiProviderFormEntry,
  type SettingsFormState,
  type SettingsOutletContext,
} from "./shared";
import {
  DEFAULT_SETTINGS_SLUG,
  SETTINGS_SECTIONS,
  firstErroredSlug,
  sectionsWithErrors,
} from "./sections";

export function SettingsRoute() {
  const { state: auth } = usePublicAuth();
  if (shouldRenderSettingsUnavailable(auth)) {
    return <PublicUnavailable />;
  }
  return <SettingsLayout />;
}

function PublicUnavailable() {
  return (
    <Document data-testid="settings-public-unavailable">
      <Document.Head title={<span>Settings</span>} />
      <Document.Body scrollable={false}>
        <div className="reveal flex flex-col items-center justify-center gap-4 py-16 text-center">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.3em] text-[color:var(--muted-foreground)]">
            unavailable
          </div>
          <h1 className="text-[20px] font-semibold tracking-tight">
            Settings are local-only
          </h1>
          <p className="max-w-md text-[14px] text-[color:var(--ink-2)]">
            Global WorktreeOS configuration can only be managed from the local
            daemon. Open this page directly on the machine running WorktreeOS.
          </p>
          <Button asChild variant="default" size="sm">
            <Link to="/">
              <ArrowLeft className="size-[14px]" />
              Back to dashboard
            </Link>
          </Button>
        </div>
      </Document.Body>
    </Document>
  );
}

/**
 * Owns the shared settings form lifecycle (config load, draft state, dirty
 * tracking, validation, save/reset, restart) and renders the persistent
 * chrome — section navigation, the Save/Reset/Restart bar, banners, and the
 * restart modal — around an `<Outlet/>`. Section pages are presentation-only
 * and read the lifecycle through `useOutletContext`.
 */
function SettingsLayout() {
  const api = useUiApi();
  const navigate = useNavigate();
  // Rail collapse/expand lives in the page header (desktop), mirroring worktree.
  const sidebar = useOutletContext<SidebarOutletContext | null>();
  const [snapshot, setSnapshot] = useState<SettingsConfigSnapshot | null>(null);
  const [certStatus, setCertStatus] = useState<
    SettingsConfigResponse["certificateStatus"]
  >(undefined);
  const [form, setForm] = useState<SettingsFormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<SettingsValidationFieldError[]>([]);
  const [restartRequired, setRestartRequired] = useState(false);
  const [revealSecret, setRevealSecret] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState<Record<number, boolean>>({});
  const [restartDialog, setRestartDialog] = useState<{
    open: boolean;
    reason: "manual" | "post-save";
  }>({ open: false, reason: "manual" });
  const [restartSubmitting, setRestartSubmitting] = useState(false);
  const [restartSubmitted, setRestartSubmitted] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  const openRestartDialog = useCallback((reason: "manual" | "post-save") => {
    setRestartError(null);
    setRestartSubmitted(false);
    setRestartDialog({ open: true, reason });
  }, []);

  const closeRestartDialog = useCallback(() => {
    if (restartSubmitting) return;
    setRestartDialog((prev) => ({ ...prev, open: false }));
    setRestartError(null);
    setRestartSubmitted(false);
  }, [restartSubmitting]);

  const restartBaselineStartedAtRef = useRef<number | null>(null);

  const handleConfirmRestart = useCallback(async () => {
    setRestartSubmitting(true);
    setRestartError(null);
    try {
      try {
        const session = await api.getAuthSession();
        restartBaselineStartedAtRef.current = session.daemonStartedAt ?? null;
      } catch {
        restartBaselineStartedAtRef.current = null;
      }
      await api.restartDaemon();
      setRestartSubmitted(true);
    } catch (e) {
      if (e instanceof UiForbiddenError) {
        setRestartError("Daemon restart is not available for this session.");
      } else if (e instanceof UiApiError) {
        setRestartError(e.message);
      } else {
        setRestartError((e as Error).message);
      }
    } finally {
      setRestartSubmitting(false);
    }
  }, [api]);

  useEffect(() => {
    if (!restartSubmitted) return;
    let cancelled = false;
    const baseline = restartBaselineStartedAtRef.current;
    const startedAtMs = Date.now();
    const probe = async () => {
      while (!cancelled) {
        try {
          const session = await api.getAuthSession();
          const current = session.daemonStartedAt;
          const elapsed = Date.now() - startedAtMs;
          if (
            (typeof current === "number" &&
              baseline !== null &&
              current !== baseline) ||
            (baseline === null && elapsed > 1500)
          ) {
            if (!cancelled) window.location.reload();
            return;
          }
        } catch {
          // daemon transient downtime — keep polling
        }
        await new Promise((r) => setTimeout(r, 600));
      }
    };
    void probe();
    return () => {
      cancelled = true;
    };
  }, [restartSubmitted, api]);

  const loadConfig = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.getSettingsConfig();
      setSnapshot(res.config);
      setCertStatus(res.certificateStatus);
      setForm(formStateFromSnapshot(res.config));
    } catch (e) {
      if (e instanceof UiForbiddenError) {
        setLoadError("Settings are unavailable for this session.");
      } else {
        setLoadError((e as Error).message);
      }
    }
  }, [api]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const baselineForm = useMemo(
    () => (snapshot ? formStateFromSnapshot(snapshot) : null),
    [snapshot],
  );
  const dirty = useMemo(() => {
    if (!form || !baselineForm) return false;
    return JSON.stringify(form) !== JSON.stringify(baselineForm);
  }, [form, baselineForm]);

  const updateField = useCallback(
    <K extends keyof SettingsFormState>(key: K, value: SettingsFormState[K]) => {
      setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
      setRestartRequired(false);
      setSaveError(null);
      setFieldErrors((prev) =>
        prev.filter((e) => !fieldKeyMatches(e.field, key)),
      );
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    setSaveError(null);
    setFieldErrors([]);
    try {
      const draft = buildDraft(form);
      const res = await api.saveSettingsConfig(draft);
      setSnapshot(res.config);
      setCertStatus(res.certificateStatus);
      setForm(formStateFromSnapshot(res.config));
      const requiresRestart = res.restartRequired === true;
      setRestartRequired(requiresRestart);
      if (requiresRestart) {
        openRestartDialog("post-save");
      }
    } catch (e) {
      if (e instanceof UiValidationError) {
        setFieldErrors(e.fieldErrors);
        setSaveError(e.message);
        // Route the user to the first section page that owns an error so the
        // inline message on that page becomes visible without hunting.
        const slug = firstErroredSlug(e.fieldErrors);
        if (slug) navigate(`/settings/${slug}`);
      } else if (e instanceof UiApiError) {
        setSaveError(e.message);
      } else {
        setSaveError((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }, [api, form, openRestartDialog, navigate]);

  const handleReset = useCallback(() => {
    if (baselineForm) setForm(baselineForm);
    setRestartRequired(false);
    setSaveError(null);
    setFieldErrors([]);
  }, [baselineForm]);

  const fieldError = useCallback(
    (field: string) => fieldErrors.find((e) => e.field === field)?.message,
    [fieldErrors],
  );

  const providerFieldError = useCallback(
    (index: number, field: string) => fieldError(`aiProviders.${index}.${field}`),
    [fieldError],
  );
  // Model validation errors target either the whole list (`…models`) or a
  // single entry (`…models.N`); match the prefix so the message lands near the
  // models control regardless.
  const providerModelsError = useCallback(
    (index: number) =>
      fieldErrors.find((e) =>
        e.field.startsWith(`aiProviders.${index}.models`),
      )?.message,
    [fieldErrors],
  );

  const updateProvider = useCallback(
    (index: number, patch: Partial<AiProviderFormEntry>) => {
      setForm((prev) => {
        if (!prev) return prev;
        const aiProviders = prev.aiProviders.map((p, i) =>
          i === index ? { ...p, ...patch } : p,
        );
        return { ...prev, aiProviders };
      });
      setRestartRequired(false);
      setSaveError(null);
      setFieldErrors((prev) =>
        prev.filter((e) => !fieldKeyMatches(e.field, "aiProviders")),
      );
    },
    [],
  );

  const addProvider = useCallback(() => {
    setForm((prev) =>
      prev
        ? { ...prev, aiProviders: [...prev.aiProviders, emptyAiProvider()] }
        : prev,
    );
    setRestartRequired(false);
    setSaveError(null);
  }, []);

  const removeProvider = useCallback((index: number) => {
    setForm((prev) =>
      prev
        ? { ...prev, aiProviders: prev.aiProviders.filter((_, i) => i !== index) }
        : prev,
    );
    setRestartRequired(false);
    setSaveError(null);
    setRevealedKeys((prev) => {
      const next: Record<number, boolean> = {};
      for (const [key, value] of Object.entries(prev)) {
        const i = Number(key);
        if (i < index) next[i] = value;
        else if (i > index) next[i - 1] = value;
      }
      return next;
    });
  }, []);

  const toggleReveal = useCallback((index: number) => {
    setRevealedKeys((prev) => ({ ...prev, [index]: !prev[index] }));
  }, []);

  const toggleRevealSecret = useCallback(() => {
    setRevealSecret((v) => !v);
  }, []);

  const erroredSlugs = useMemo(
    () => sectionsWithErrors(fieldErrors),
    [fieldErrors],
  );

  const outletContext: SettingsOutletContext | null =
    form && snapshot
      ? {
          form,
          snapshot,
          certStatus,
          updateField,
          fieldError,
          providerFieldError,
          providerModelsError,
          updateProvider,
          addProvider,
          removeProvider,
          revealSecret,
          toggleRevealSecret,
          revealedKeys,
          toggleReveal,
        }
      : null;

  return (
    <Document data-testid="settings-page">
      <Document.Head
        title={
          <span className="inline-flex items-center gap-2">
            {sidebar && (
              <SidebarToggle
                sidebarOpen={sidebar.sidebarOpen}
                onToggle={sidebar.toggleSidebar}
                className="-ml-1"
              />
            )}
            <Link
              to="/"
              aria-label="Back to dashboard"
              className="inline-flex items-center justify-center size-[22px] rounded-md text-[color:var(--muted-foreground)] hover:bg-[color:var(--hover)] hover:text-[color:var(--ink)] transition-colors"
            >
              <ArrowLeft className="size-[14px]" />
            </Link>
            <span>Settings</span>
          </span>
        }
        status={snapshot ? <span>Local · {snapshot.path}</span> : null}
      />
      <Document.Body scrollable={false}>
        {loadError && (
          <TodoBanner tone="failed" data-testid="settings-load-error">
            {loadError}
          </TodoBanner>
        )}
        {!loadError && !snapshot && (
          <div className="flex items-center gap-2 text-[color:var(--muted-foreground)] text-[13px]">
            <Loader2 className="size-3 animate-spin" />
            Loading settings…
          </div>
        )}
        {snapshot && outletContext && (
          <>
            {!snapshot.exists && (
              <TodoBanner
                tone="idle"
                data-testid="settings-absent-banner"
                meta={<Ic>{snapshot.path}</Ic>}
              >
                No config file yet. Saving will create{" "}
                <Ic>{snapshot.path}</Ic>.
              </TodoBanner>
            )}
            {restartRequired && (
              <TodoBanner tone="done" data-testid="settings-restart-required">
                Settings saved. Restart the WorktreeOS daemon to apply them.
              </TodoBanner>
            )}
            {saveError && (
              <TodoBanner tone="failed" data-testid="settings-save-error">
                {saveError}
              </TodoBanner>
            )}

            <div className="lg:grid lg:grid-cols-[176px_minmax(0,1fr)] lg:gap-8">
              <SettingsNav erroredSlugs={erroredSlugs} />
              <div className="min-w-0">
                <Outlet context={outletContext} />

                <div className="mt-8 flex items-center gap-2.5">
                  <Button
                    type="button"
                    variant="solid"
                    size="md"
                    onClick={handleSave}
                    disabled={saving}
                    data-testid="settings-save"
                  >
                    {saving ? (
                      <>
                        <Loader2 className="size-[14px] animate-spin" />
                        Saving…
                      </>
                    ) : (
                      "Save settings"
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="md"
                    onClick={handleReset}
                    disabled={saving || !dirty}
                    data-testid="settings-reset"
                  >
                    Reset changes
                  </Button>
                  <Button
                    type="button"
                    variant="default"
                    size="md"
                    onClick={() => openRestartDialog("manual")}
                    disabled={saving || restartSubmitting}
                    data-testid="settings-restart-daemon"
                  >
                    <RefreshCw className="size-[14px]" />
                    Restart daemon
                  </Button>
                  {dirty ? (
                    <span className="text-[12.5px] text-[color:var(--muted-foreground)]">
                      Unsaved changes
                    </span>
                  ) : restartRequired ? (
                    <span
                      className="inline-flex items-center gap-1.5 text-[12.5px] text-[color:var(--good)]"
                      data-testid="settings-saved-inline"
                    >
                      <Check className="size-[13px]" />
                      <span className="text-[color:var(--ink)]">
                        Saved · restart the WorktreeOS daemon to apply
                      </span>
                    </span>
                  ) : (
                    <span className="text-[12.5px] text-[color:var(--muted-foreground)]">
                      Up to date
                    </span>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </Document.Body>
      {restartDialog.open && (
        <DaemonRestartModal
          submitting={restartSubmitting}
          submitted={restartSubmitted}
          error={restartError}
          reason={restartDialog.reason}
          onCancel={closeRestartDialog}
          onConfirm={handleConfirmRestart}
        />
      )}
    </Document>
  );
}

/**
 * Settings section navigation. `NavLink`s drive real per-section routes under
 * `/settings` with active state; a section whose validation errors are present
 * gets a trailing error dot. Horizontal scroll list on narrow screens, sticky
 * vertical rail on desktop.
 */
function SettingsNav({ erroredSlugs }: { erroredSlugs: Set<string> }) {
  return (
    <nav
      aria-label="Settings sections"
      data-testid="settings-section-nav"
      className="mb-4 flex gap-1 overflow-x-auto lg:mb-0 lg:flex-col lg:overflow-visible lg:sticky lg:top-6 lg:self-start"
    >
      {SETTINGS_SECTIONS.map((section) => {
        const hasError = erroredSlugs.has(section.slug);
        return (
          <NavLink
            key={section.slug}
            to={section.slug}
            data-testid={`settings-nav-${section.slug}`}
            className={({ isActive }) =>
              cn(
                "inline-flex items-center justify-between gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
                isActive
                  ? "bg-[color:var(--hover)] text-[color:var(--ink)] font-medium"
                  : "text-[color:var(--ink-2)] hover:bg-[color:var(--hover)] hover:text-[color:var(--ink)]",
              )
            }
          >
            <span>{section.label}</span>
            {hasError && (
              <span
                aria-label="section has validation errors"
                data-testid={`settings-nav-error-${section.slug}`}
                className="inline-block size-1.5 rounded-full bg-[color:var(--bad)]"
              />
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}

export { DEFAULT_SETTINGS_SLUG };
