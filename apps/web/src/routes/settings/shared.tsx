import type { ReactNode } from "react";
import { useOutletContext } from "react-router";
import { DocumentSection } from "@/routes/worktree/document";
import {
  type SettingsAiProviderDraft,
  type SettingsAiProviderType,
  type SettingsCertificateStatus,
  type SettingsConfigDraft,
  type SettingsConfigResponse,
  type SettingsConfigSnapshot,
  type SettingsEffectiveAiProvider,
  type SettingsLetsEncryptChallengeProvider,
  type SettingsSslCertificateSource,
  type SettingsTerminalBackend,
} from "@/lib/ui-api";
import {
  commitMessageFieldsFromSnapshot,
  commitMessagesDraftFromFields,
} from "@/lib/commit-message-settings";
import { cn } from "@/lib/utils";

export type SettingsFormState = {
  webPort: string;
  webHost: string;
  tunnelWebUiEnabled: boolean;
  tunnelWebUiSubdomain: string;
  tunnelWebUiSecret: string;
  tunnelWebUiTerminalEnabled: boolean;
  tunnelWebUiWhitelist: string;
  serviceTunnelsEnabled: boolean;
  serviceTunnelsWhitelist: string;
  tunnelEnabled: boolean;
  tunnelPort: string;
  tunnelPublicPort: string;
  tunnelDomain: string;
  tunnelSslEnabled: boolean;
  tunnelSslSource: SettingsSslCertificateSource;
  tunnelSslCert: string;
  tunnelSslKey: string;
  tunnelLeEmail: string;
  tunnelLeProvider: SettingsLetsEncryptChallengeProvider;
  tunnelLeCreate: string;
  tunnelLeDelete: string;
  tunnelLePropagation: string;
  tunnelLeCfTokenEnv: string;
  tunnelLeCfApiToken: string;
  tunnelLeCfZoneId: string;
  hcTimeout: string;
  hcStartPeriod: string;
  hcInterval: string;
  hcRequestTimeout: string;
  hcRetries: string;
  terminalBackend: SettingsTerminalBackend;
  editorCommand: string;
  serviceBind: string;
  aiProviders: AiProviderFormEntry[];
  /** Default commit-message provider name; "" means none. */
  commitMessageProvider: string;
  /** Default commit-message model; "" means provider default. */
  commitMessageModel: string;
  autoInjectAgentPlugins: boolean;
};

/** One editable AI provider row. `models` is a comma/newline-separated string. */
export type AiProviderFormEntry = {
  type: SettingsAiProviderType;
  name: string;
  apiKey: string;
  baseUrl: string;
  models: string;
};

export const AI_PROVIDER_TYPE_OPTIONS: ReadonlyArray<{
  value: SettingsAiProviderType;
  label: string;
}> = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "openai-like", label: "OpenAI-compatible" },
  { value: "anthropic-like", label: "Anthropic-compatible" },
];

function isAiProviderType(value: unknown): value is SettingsAiProviderType {
  return (
    value === "openai" ||
    value === "anthropic" ||
    value === "openrouter" ||
    value === "openai-like" ||
    value === "anthropic-like"
  );
}

export function emptyAiProvider(): AiProviderFormEntry {
  return { type: "openai", name: "", apiKey: "", baseUrl: "", models: "" };
}

export const SSL_SOURCE_OPTIONS: ReadonlyArray<{
  value: SettingsSslCertificateSource;
  label: string;
}> = [
  { value: "self-signed", label: "Generated self-signed" },
  { value: "files", label: "Certificate files" },
  { value: "letsencrypt", label: "Let's Encrypt" },
];

export const LE_PROVIDER_OPTIONS: ReadonlyArray<{
  value: SettingsLetsEncryptChallengeProvider;
  label: string;
}> = [
  { value: "cloudflare", label: "Cloudflare" },
  { value: "hook", label: "Custom DNS hook" },
];

function isSslSource(value: unknown): value is SettingsSslCertificateSource {
  return value === "files" || value === "self-signed" || value === "letsencrypt";
}

function isLeProvider(
  value: unknown,
): value is SettingsLetsEncryptChallengeProvider {
  return value === "hook" || value === "cloudflare";
}

/** Best-guess SSL source for legacy backends that omit `source`. */
function inferLegacySource(
  raw: { cert?: string; key?: string } | undefined,
): SettingsSslCertificateSource {
  if (raw && typeof raw.cert === "string" && typeof raw.key === "string") {
    return "files";
  }
  return "self-signed";
}

export function isTerminalBackend(value: unknown): value is SettingsTerminalBackend {
  return value === "default" || value === "tmux";
}

function durationToInput(v: number | string | undefined): string {
  if (v === undefined || v === null) return "";
  return String(v);
}

function numberToInput(v: number | undefined): string {
  if (v === undefined || v === null) return "";
  return String(v);
}

/**
 * Hydrate AI provider form rows from the snapshot. Prefer raw file values (so
 * partially-invalid entries remain editable for correction); fall back to the
 * effective list when the file is absent.
 */
function aiProvidersToForm(
  raw: SettingsAiProviderDraft[] | undefined,
  effective: SettingsEffectiveAiProvider[],
): AiProviderFormEntry[] {
  const source: ReadonlyArray<SettingsAiProviderDraft | SettingsEffectiveAiProvider> =
    raw ?? effective;
  return source.map((p) => ({
    type: isAiProviderType(p.type) ? p.type : "openai",
    name: p.name ?? "",
    apiKey: p.apiKey ?? "",
    baseUrl: p.baseUrl ?? "",
    models: (p.models ?? []).join("\n"),
  }));
}

export function formStateFromSnapshot(
  snap: SettingsConfigSnapshot,
): SettingsFormState {
  const raw = snap.raw ?? {};
  const eff = snap.effective;
  const rawPort = raw.web?.port;
  const rawTunnel = raw.tunnel;
  const rawTunnelSsl = raw.tunnel?.ssl;
  const rawTunnelWebUi = raw.tunnel?.webUi;
  const rawServiceTunnels = raw.tunnel?.serviceTunnels;
  const rawHealthcheck = raw.healthcheck;
  const effWebUi = eff.tunnel.webUi;
  const effServiceTunnels = eff.tunnel.serviceTunnels;
  const effTunnelSsl = eff.tunnel.ssl;
  // Resolve effective source with strict fallbacks so a stale backend (no
  // `effectiveSsl` block, no `source` on the SSL union) never lands an
  // `undefined` in the SelectInput — which would turn it into an
  // uncontrolled element and surprise React reconciliation.
  const effTunnelSource: SettingsSslCertificateSource | "disabled" =
    snap.effectiveSsl?.tunnel.source ??
    (effTunnelSsl.enabled && isSslSource(effTunnelSsl.source)
      ? effTunnelSsl.source
      : effTunnelSsl.enabled
        ? inferLegacySource(rawTunnelSsl)
        : "disabled");
  const tunnelSslSource: SettingsSslCertificateSource = isSslSource(
    rawTunnelSsl?.source,
  )
    ? rawTunnelSsl.source
    : effTunnelSource === "disabled"
      ? "self-signed"
      : effTunnelSource;
  const tunnelLe =
    rawTunnelSsl?.letsencrypt ??
    (effTunnelSsl.enabled && effTunnelSsl.source === "letsencrypt"
      ? effTunnelSsl.letsencrypt
      : undefined);
  return {
    webPort: numberToInput(rawPort ?? eff.web.port),
    webHost:
      typeof raw.web?.host === "string" ? raw.web.host : (eff.web.host ?? ""),
    tunnelWebUiEnabled:
      rawTunnelWebUi?.enabled === undefined
        ? effWebUi.enabled
        : rawTunnelWebUi.enabled,
    tunnelWebUiSubdomain:
      rawTunnelWebUi?.subdomain ??
      (effWebUi.enabled ? effWebUi.hostname : ""),
    tunnelWebUiSecret:
      rawTunnelWebUi?.secret ?? (effWebUi.enabled ? effWebUi.secret : ""),
    tunnelWebUiTerminalEnabled:
      rawTunnelWebUi?.terminalEnabled === undefined
        ? effWebUi.enabled
          ? effWebUi.terminalEnabled
          : false
        : rawTunnelWebUi.terminalEnabled,
    tunnelWebUiWhitelist:
      (rawTunnelWebUi?.whitelistIps ??
        (effWebUi.enabled ? effWebUi.whitelistIps : [])).join("\n"),
    serviceTunnelsEnabled:
      rawServiceTunnels?.enabled === undefined
        ? effServiceTunnels.enabled
        : rawServiceTunnels.enabled,
    serviceTunnelsWhitelist:
      (rawServiceTunnels?.whitelistIps ?? effServiceTunnels.whitelistIps).join("\n"),
    tunnelEnabled:
      rawTunnel?.enabled === undefined ? eff.tunnel.enabled : rawTunnel.enabled,
    tunnelPort: numberToInput(rawTunnel?.port ?? eff.tunnel.port),
    tunnelPublicPort: numberToInput(rawTunnel?.publicPort ?? eff.tunnel.publicPort),
    tunnelDomain:
      rawTunnel?.domain ?? (eff.tunnel.enabled ? eff.tunnel.domain : ""),
    tunnelSslEnabled:
      rawTunnelSsl?.enabled === undefined
        ? effTunnelSsl.enabled
        : rawTunnelSsl.enabled,
    tunnelSslSource,
    tunnelSslCert:
      rawTunnelSsl?.cert ??
      (effTunnelSsl.enabled && effTunnelSsl.source === "files"
        ? effTunnelSsl.cert
        : ""),
    tunnelSslKey:
      rawTunnelSsl?.key ??
      (effTunnelSsl.enabled && effTunnelSsl.source === "files"
        ? effTunnelSsl.key
        : ""),
    tunnelLeEmail: tunnelLe?.email ?? "",
    tunnelLeProvider: isLeProvider(tunnelLe?.challenge?.provider)
      ? tunnelLe.challenge.provider
      : "cloudflare",
    tunnelLeCreate:
      tunnelLe?.challenge?.provider === "hook"
        ? (tunnelLe.challenge.createCommand ?? "")
        : "",
    tunnelLeDelete:
      tunnelLe?.challenge?.provider === "hook"
        ? (tunnelLe.challenge.deleteCommand ?? "")
        : "",
    tunnelLePropagation: numberToInput(tunnelLe?.challenge?.propagationSeconds),
    tunnelLeCfTokenEnv:
      tunnelLe?.challenge?.provider === "cloudflare"
        ? (tunnelLe.challenge.apiTokenEnv ?? "")
        : "",
    tunnelLeCfApiToken:
      tunnelLe?.challenge?.provider === "cloudflare"
        ? (tunnelLe.challenge.apiToken ?? "")
        : "",
    tunnelLeCfZoneId:
      tunnelLe?.challenge?.provider === "cloudflare"
        ? (tunnelLe.challenge.zoneId ?? "")
        : "",
    hcTimeout: durationToInput(rawHealthcheck?.timeout),
    hcStartPeriod: durationToInput(rawHealthcheck?.start_period),
    hcInterval: durationToInput(rawHealthcheck?.interval),
    hcRequestTimeout: durationToInput(rawHealthcheck?.request_timeout),
    hcRetries: numberToInput(rawHealthcheck?.retries),
    terminalBackend: isTerminalBackend(raw.terminalBackend)
      ? raw.terminalBackend
      : eff.terminalBackend,
    editorCommand:
      typeof raw.editorCommand === "string"
        ? raw.editorCommand
        : (eff.editorCommand ?? ""),
    serviceBind:
      typeof raw.serviceBind === "string"
        ? raw.serviceBind
        : (eff.serviceBind ?? ""),
    aiProviders: aiProvidersToForm(raw.aiProviders, eff.aiProviders),
    commitMessageProvider: commitMessageFieldsFromSnapshot(snap).provider,
    commitMessageModel: commitMessageFieldsFromSnapshot(snap).model,
    autoInjectAgentPlugins:
      typeof raw.autoInjectAgentPlugins === "boolean"
        ? raw.autoInjectAgentPlugins
        : (eff.autoInjectAgentPlugins ?? false),
  };
}

function parseIntOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n)) return Number.NaN;
  return n;
}

function parseDurationOrPassthrough(value: string): number | string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

interface ChallengeDraftInput {
  provider: SettingsLetsEncryptChallengeProvider;
  create: string;
  delete: string;
  propagation: string;
  cfTokenEnv: string;
  cfApiToken: string;
  cfZoneId: string;
}

function buildChallengeDraft(input: ChallengeDraftInput) {
  const propagation = parseIntOrUndefined(input.propagation);
  const propagationField =
    propagation !== undefined && !Number.isNaN(propagation)
      ? { propagationSeconds: propagation }
      : {};
  if (input.provider === "cloudflare") {
    const envName = input.cfTokenEnv.trim();
    const token = input.cfApiToken.trim();
    const zone = input.cfZoneId.trim();
    return {
      type: "dns-01" as const,
      provider: "cloudflare" as const,
      ...(envName.length > 0 ? { apiTokenEnv: envName } : {}),
      ...(token.length > 0 ? { apiToken: token } : {}),
      ...(zone.length > 0 ? { zoneId: zone } : {}),
      ...propagationField,
    };
  }
  return {
    type: "dns-01" as const,
    provider: "hook" as const,
    createCommand: input.create.trim(),
    deleteCommand: input.delete.trim(),
    ...propagationField,
  };
}

function parseWhitelistInput(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function buildDraft(state: SettingsFormState): SettingsConfigDraft {
  const draft: SettingsConfigDraft = {};
  const web: NonNullable<SettingsConfigDraft["web"]> = {};
  const port = parseIntOrUndefined(state.webPort);
  if (port !== undefined) web.port = port;
  web.host = state.webHost.trim();
  draft.web = web;
  const tunnel: SettingsConfigDraft["tunnel"] = {
    enabled: state.tunnelEnabled,
  };
  const tport = parseIntOrUndefined(state.tunnelPort);
  if (tport !== undefined) tunnel.port = tport;
  const tpublic = parseIntOrUndefined(state.tunnelPublicPort);
  if (tpublic !== undefined) tunnel.publicPort = tpublic;
  if (state.tunnelDomain.trim().length > 0) {
    tunnel.domain = state.tunnelDomain.trim();
  }
  const tunnelSsl: NonNullable<NonNullable<SettingsConfigDraft["tunnel"]>["ssl"]> = {
    enabled: state.tunnelSslEnabled,
    source: state.tunnelSslSource,
  };
  if (state.tunnelSslSource === "files") {
    if (state.tunnelSslCert.trim().length > 0) {
      tunnelSsl.cert = state.tunnelSslCert.trim();
    }
    if (state.tunnelSslKey.trim().length > 0) {
      tunnelSsl.key = state.tunnelSslKey.trim();
    }
  }
  if (state.tunnelSslSource === "letsencrypt") {
    tunnelSsl.letsencrypt = {
      email: state.tunnelLeEmail.trim(),
      acceptTerms: true,
      directory: "production",
      challenge: buildChallengeDraft({
        provider: state.tunnelLeProvider,
        create: state.tunnelLeCreate,
        delete: state.tunnelLeDelete,
        propagation: state.tunnelLePropagation,
        cfTokenEnv: state.tunnelLeCfTokenEnv,
        cfApiToken: state.tunnelLeCfApiToken,
        cfZoneId: state.tunnelLeCfZoneId,
      }),
    };
  }
  tunnel.ssl = tunnelSsl;
  const webUiDraft: NonNullable<
    NonNullable<SettingsConfigDraft["tunnel"]>["webUi"]
  > = {
    enabled: state.tunnelWebUiEnabled,
    terminalEnabled: state.tunnelWebUiTerminalEnabled,
  };
  if (state.tunnelWebUiSubdomain.trim().length > 0) {
    webUiDraft.subdomain = state.tunnelWebUiSubdomain.trim();
  }
  if (state.tunnelWebUiSecret.length > 0) {
    webUiDraft.secret = state.tunnelWebUiSecret;
  }
  const webUiWhitelist = parseWhitelistInput(state.tunnelWebUiWhitelist);
  webUiDraft.whitelistIps = webUiWhitelist;
  tunnel.webUi = webUiDraft;
  const serviceTunnelsDraft: NonNullable<
    NonNullable<SettingsConfigDraft["tunnel"]>["serviceTunnels"]
  > = {
    enabled: state.serviceTunnelsEnabled,
    whitelistIps: parseWhitelistInput(state.serviceTunnelsWhitelist),
  };
  tunnel.serviceTunnels = serviceTunnelsDraft;
  draft.tunnel = tunnel;
  const hc: SettingsConfigDraft["healthcheck"] = {};
  const t = parseDurationOrPassthrough(state.hcTimeout);
  if (t !== undefined) hc.timeout = t;
  const sp = parseDurationOrPassthrough(state.hcStartPeriod);
  if (sp !== undefined) hc.start_period = sp;
  const it = parseDurationOrPassthrough(state.hcInterval);
  if (it !== undefined) hc.interval = it;
  const rt = parseDurationOrPassthrough(state.hcRequestTimeout);
  if (rt !== undefined) hc.request_timeout = rt;
  const retries = parseIntOrUndefined(state.hcRetries);
  if (retries !== undefined) hc.retries = retries;
  if (Object.keys(hc).length > 0) draft.healthcheck = hc;
  draft.terminalBackend = state.terminalBackend;
  draft.editorCommand = state.editorCommand.trim();
  draft.serviceBind = state.serviceBind.trim();
  draft.aiProviders = state.aiProviders.map((p) => {
    const entry: SettingsAiProviderDraft = {
      type: p.type,
      apiKey: p.apiKey.trim(),
    };
    if (p.name.trim().length > 0) entry.name = p.name.trim();
    if (p.baseUrl.trim().length > 0) entry.baseUrl = p.baseUrl.trim();
    const models = parseWhitelistInput(p.models);
    if (models.length > 0) entry.models = models;
    return entry;
  });
  // Always present (possibly empty) so a cleared default round-trips as a clear.
  draft.commitMessages = commitMessagesDraftFromFields({
    provider: state.commitMessageProvider,
    model: state.commitMessageModel,
  });
  draft.autoInjectAgentPlugins = state.autoInjectAgentPlugins;
  return draft;
}

export function fieldKeyMatches(
  field: string,
  key: keyof SettingsFormState,
): boolean {
  switch (key) {
    case "webPort":
      return field === "web.port" || field === "web";
    case "webHost":
      return field === "web.host" || field === "web";
    case "tunnelWebUiEnabled":
      return field === "tunnel.webUi.enabled" || field === "tunnel.webUi";
    case "tunnelWebUiSubdomain":
      return field === "tunnel.webUi.subdomain";
    case "tunnelWebUiSecret":
      return field === "tunnel.webUi.secret";
    case "tunnelWebUiTerminalEnabled":
      return field === "tunnel.webUi.terminalEnabled";
    case "tunnelWebUiWhitelist":
      return field === "tunnel.webUi.whitelistIps";
    case "serviceTunnelsEnabled":
      return field === "tunnel.serviceTunnels.enabled" || field === "tunnel.serviceTunnels";
    case "serviceTunnelsWhitelist":
      return field === "tunnel.serviceTunnels.whitelistIps";
    case "tunnelEnabled":
      return field === "tunnel.enabled" || field === "tunnel";
    case "tunnelPort":
      return field === "tunnel.port";
    case "tunnelPublicPort":
      return field === "tunnel.publicPort";
    case "tunnelDomain":
      return field === "tunnel.domain";
    case "tunnelSslEnabled":
      return field === "tunnel.ssl.enabled" || field === "tunnel.ssl";
    case "tunnelSslSource":
      return field === "tunnel.ssl.source";
    case "tunnelSslCert":
      return field === "tunnel.ssl.cert";
    case "tunnelSslKey":
      return field === "tunnel.ssl.key";
    case "tunnelLeEmail":
      return field === "tunnel.ssl.letsencrypt.email";
    case "tunnelLeProvider":
      return field === "tunnel.ssl.letsencrypt.challenge.provider";
    case "tunnelLeCreate":
      return field === "tunnel.ssl.letsencrypt.challenge.createCommand";
    case "tunnelLeDelete":
      return field === "tunnel.ssl.letsencrypt.challenge.deleteCommand";
    case "tunnelLePropagation":
      return field === "tunnel.ssl.letsencrypt.challenge.propagationSeconds";
    case "tunnelLeCfTokenEnv":
      return field === "tunnel.ssl.letsencrypt.challenge.apiTokenEnv";
    case "tunnelLeCfApiToken":
      return field === "tunnel.ssl.letsencrypt.challenge.apiToken";
    case "tunnelLeCfZoneId":
      return field === "tunnel.ssl.letsencrypt.challenge.zoneId";
    case "hcTimeout":
      return field === "healthcheck.timeout";
    case "hcStartPeriod":
      return field === "healthcheck.start_period";
    case "hcInterval":
      return field === "healthcheck.interval";
    case "hcRequestTimeout":
      return field === "healthcheck.request_timeout";
    case "hcRetries":
      return field === "healthcheck.retries";
    case "terminalBackend":
      return field === "terminalBackend";
    case "editorCommand":
      return field === "editorCommand";
    case "serviceBind":
      return field === "serviceBind";
    case "autoInjectAgentPlugins":
      return field === "autoInjectAgentPlugins";
    case "aiProviders":
      return field === "aiProviders" || field.startsWith("aiProviders.");
    case "commitMessageProvider":
      return field === "commitMessages.provider" || field === "commitMessages";
    case "commitMessageModel":
      return field === "commitMessages.model";
    default:
      return false;
  }
}

/**
 * Shared form lifecycle the `/settings` layout owns and exposes to every
 * section page through `useOutletContext`. Pages are presentation-only: they
 * read `form`, mutate it through `updateField`/provider helpers, and surface
 * validation through `fieldError`. `snapshot`/`form` are non-null because the
 * layout only renders the `<Outlet/>` once the config has loaded.
 */
export interface SettingsOutletContext {
  form: SettingsFormState;
  snapshot: SettingsConfigSnapshot;
  certStatus: SettingsConfigResponse["certificateStatus"];
  updateField: <K extends keyof SettingsFormState>(
    key: K,
    value: SettingsFormState[K],
  ) => void;
  fieldError: (field: string) => string | undefined;
  providerFieldError: (index: number, field: string) => string | undefined;
  providerModelsError: (index: number) => string | undefined;
  updateProvider: (index: number, patch: Partial<AiProviderFormEntry>) => void;
  addProvider: () => void;
  removeProvider: (index: number) => void;
  revealSecret: boolean;
  toggleRevealSecret: () => void;
  revealedKeys: Record<number, boolean>;
  toggleReveal: (index: number) => void;
}

export function useSettingsContext(): SettingsOutletContext {
  return useOutletContext<SettingsOutletContext>();
}

export function Section({
  title,
  id,
  children,
}: {
  title: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <DocumentSection title={title} id={id} className="scroll-mt-6">
      <div className="flex flex-col divide-y divide-[color:var(--hair)] border-y border-[color:var(--hair)]">
        {children}
      </div>
    </DocumentSection>
  );
}

export function FormRow({
  label,
  htmlFor,
  hint,
  error,
  muted,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid gap-2 py-3.5 md:grid-cols-[220px_minmax(0,1fr)] md:items-start",
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
          <p
            className="text-[12.5px] text-[color:var(--bad)] m-0"
            data-testid="settings-field-error"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  type = "text",
  "data-testid": testId,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "password";
  "data-testid"?: string;
}) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      data-testid={testId}
      className="w-full max-w-md rounded-md border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-2.5 py-1.5 text-[13.5px] text-[color:var(--ink)] outline-none focus-visible:border-[color:var(--ink)]/40 focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_oklch,var(--ink)_18%,transparent)]"
    />
  );
}

export function SelectInput<T extends string>({
  value,
  onChange,
  options,
  "data-testid": testId,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string }>;
  "data-testid"?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      data-testid={testId}
      className="w-full max-w-md rounded-md border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-2.5 py-1.5 text-[13.5px] text-[color:var(--ink)] outline-none focus-visible:border-[color:var(--ink)]/40 focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_oklch,var(--ink)_18%,transparent)]"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function NumberInput(props: {
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

export function SelfSignedHint({ listener }: { listener: "web" | "tunnel" }) {
  const message =
    listener === "web"
      ? "WorktreeOS generates and reuses a self-signed certificate under <wos-home>/certs covering localhost, 127.0.0.1, and the configured public hostname. Browsers will require a trust exception on first visit."
      : "WorktreeOS generates and reuses a self-signed wildcard certificate under <wos-home>/certs covering tunnel.domain and *.tunnel.domain. Browsers will require a trust exception on first visit.";
  return (
    <FormRow
      label="Self-signed certificate"
      hint="No additional fields are required for this source. Save and restart the daemon to apply."
    >
      <p
        className="text-[13px] text-[color:var(--ink-2)] m-0 max-w-prose"
        data-testid={`settings-${listener}-self-signed-hint`}
      >
        {message}
      </p>
    </FormRow>
  );
}

export interface LetsEncryptFieldState {
  email: string;
  provider: SettingsLetsEncryptChallengeProvider;
  create: string;
  delete: string;
  propagation: string;
  cfTokenEnv: string;
  cfApiToken: string;
  cfZoneId: string;
}

type LetsEncryptFieldValue = string | SettingsLetsEncryptChallengeProvider;

export function LetsEncryptFields({
  prefix,
  state,
  setField,
  fieldError,
}: {
  prefix: "web" | "tunnel";
  state: LetsEncryptFieldState;
  setField: (key: keyof LetsEncryptFieldState, value: LetsEncryptFieldValue) => void;
  fieldError: (field: string) => string | undefined;
}) {
  const fieldPrefix = `${prefix}.ssl.letsencrypt`;
  return (
    <>
      <FormRow
        label="Let's Encrypt email"
        htmlFor={`settings-${prefix}-le-email`}
        hint="Used for the ACME account. Let's Encrypt notifies this address before certificates expire."
        error={fieldError(`${fieldPrefix}.email`)}
      >
        <TextInput
          id={`settings-${prefix}-le-email`}
          value={state.email}
          onChange={(v) => setField("email", v)}
          placeholder="ops@example.com"
          data-testid={`settings-${prefix}-le-email`}
        />
      </FormRow>
      <FormRow
        label="DNS challenge provider"
        hint="Cloudflare uses a scoped API token to publish ACME TXT records. Custom DNS hook runs shell commands you control."
        error={fieldError(`${fieldPrefix}.challenge.provider`)}
      >
        <SelectInput
          value={state.provider}
          onChange={(v) => setField("provider", v)}
          options={LE_PROVIDER_OPTIONS}
          data-testid={`settings-${prefix}-le-provider`}
        />
      </FormRow>
      {state.provider === "cloudflare" ? (
        <CloudflareChallengeFields
          prefix={prefix}
          state={state}
          setField={setField}
          fieldError={fieldError}
        />
      ) : (
        <HookChallengeFields
          prefix={prefix}
          state={state}
          setField={setField}
          fieldError={fieldError}
        />
      )}
      <FormRow
        label="Propagation wait (seconds)"
        htmlFor={`settings-${prefix}-le-propagation`}
        hint="How long to wait after publishing the TXT record before asking the ACME server to validate."
        error={fieldError(`${fieldPrefix}.challenge.propagationSeconds`)}
      >
        <NumberInput
          id={`settings-${prefix}-le-propagation`}
          value={state.propagation}
          onChange={(v) => setField("propagation", v)}
          placeholder="30"
          data-testid={`settings-${prefix}-le-propagation`}
        />
      </FormRow>
    </>
  );
}

function HookChallengeFields({
  prefix,
  state,
  setField,
  fieldError,
}: {
  prefix: "web" | "tunnel";
  state: LetsEncryptFieldState;
  setField: (key: keyof LetsEncryptFieldState, value: LetsEncryptFieldValue) => void;
  fieldError: (field: string) => string | undefined;
}) {
  const fieldPrefix = `${prefix}.ssl.letsencrypt.challenge`;
  return (
    <>
      <FormRow
        label="DNS create hook"
        htmlFor={`settings-${prefix}-le-create`}
        hint="Shell command run to publish a TXT record. Receives WOS_ACME_* env vars."
        error={fieldError(`${fieldPrefix}.createCommand`)}
      >
        <TextInput
          id={`settings-${prefix}-le-create`}
          value={state.create}
          onChange={(v) => setField("create", v)}
          placeholder="/usr/local/bin/dns-create"
          data-testid={`settings-${prefix}-le-create`}
        />
      </FormRow>
      <FormRow
        label="DNS delete hook"
        htmlFor={`settings-${prefix}-le-delete`}
        hint="Shell command run to remove the TXT record after validation."
        error={fieldError(`${fieldPrefix}.deleteCommand`)}
      >
        <TextInput
          id={`settings-${prefix}-le-delete`}
          value={state.delete}
          onChange={(v) => setField("delete", v)}
          placeholder="/usr/local/bin/dns-delete"
          data-testid={`settings-${prefix}-le-delete`}
        />
      </FormRow>
    </>
  );
}

function CloudflareChallengeFields({
  prefix,
  state,
  setField,
  fieldError,
}: {
  prefix: "web" | "tunnel";
  state: LetsEncryptFieldState;
  setField: (key: keyof LetsEncryptFieldState, value: LetsEncryptFieldValue) => void;
  fieldError: (field: string) => string | undefined;
}) {
  const fieldPrefix = `${prefix}.ssl.letsencrypt.challenge`;
  return (
    <>
      <FormRow
        label="Cloudflare token env var"
        htmlFor={`settings-${prefix}-le-cf-token-env`}
        hint="Name of the environment variable in the daemon's process that holds a scoped Cloudflare API token (Zone:Read + DNS:Edit). Recommended over storing the token directly."
        error={fieldError(`${fieldPrefix}.apiTokenEnv`)}
      >
        <TextInput
          id={`settings-${prefix}-le-cf-token-env`}
          value={state.cfTokenEnv}
          onChange={(v) => setField("cfTokenEnv", v)}
          placeholder="CF_API_TOKEN"
          data-testid={`settings-${prefix}-le-cf-token-env`}
        />
      </FormRow>
      <FormRow
        label="Cloudflare API token (direct)"
        htmlFor={`settings-${prefix}-le-cf-api-token`}
        hint="Optional. Stored in config.json — leave blank and use the env var instead unless you understand the trade-off."
        error={fieldError(`${fieldPrefix}.apiToken`)}
      >
        <TextInput
          id={`settings-${prefix}-le-cf-api-token`}
          type="password"
          value={state.cfApiToken}
          onChange={(v) => setField("cfApiToken", v)}
          placeholder=""
          data-testid={`settings-${prefix}-le-cf-api-token`}
        />
      </FormRow>
      <FormRow
        label="Cloudflare zone id (optional)"
        htmlFor={`settings-${prefix}-le-cf-zone-id`}
        hint="Set when the token cannot list zones or to skip zone discovery on each renewal."
        error={fieldError(`${fieldPrefix}.zoneId`)}
      >
        <TextInput
          id={`settings-${prefix}-le-cf-zone-id`}
          value={state.cfZoneId}
          onChange={(v) => setField("cfZoneId", v)}
          placeholder=""
          data-testid={`settings-${prefix}-le-cf-zone-id`}
        />
      </FormRow>
    </>
  );
}

export function CertificateStatusRow({
  status,
  listener,
}: {
  status: SettingsCertificateStatus;
  listener: "web" | "tunnel";
}) {
  const label = listener === "web" ? "Web certificate status" : "Tunnel certificate status";
  const dotColor =
    status.state === "active"
      ? "var(--good)"
      : status.state === "failed"
        ? "var(--bad)"
        : status.state === "issuing" || status.state === "renewing"
          ? "var(--warn)"
          : "var(--ink-2)";
  return (
    <FormRow label={label} hint="Read-only · refresh by reloading the page.">
      <div
        className="flex flex-col gap-1 text-[13px] text-[color:var(--ink-2)]"
        data-testid={`settings-${listener}-cert-status`}
      >
        <span className="inline-flex items-center gap-2 text-[color:var(--ink)]">
          <span
            className="inline-block size-2 rounded-full"
            style={{ background: dotColor }}
            aria-hidden
          />
          {status.source} · {status.state}
        </span>
        {status.hostnames.length > 0 && (
          <span data-testid={`settings-${listener}-cert-hostnames`}>
            covers {status.hostnames.join(", ")}
          </span>
        )}
        {status.notAfter && (
          <span data-testid={`settings-${listener}-cert-not-after`}>
            expires {status.notAfter}
          </span>
        )}
        {status.lastSuccessAt && (
          <span>last success {status.lastSuccessAt}</span>
        )}
        {status.lastError && (
          <span
            className="text-[color:var(--bad)]"
            data-testid={`settings-${listener}-cert-error`}
          >
            {status.lastError.phase}: {status.lastError.message}
          </span>
        )}
      </div>
    </FormRow>
  );
}
