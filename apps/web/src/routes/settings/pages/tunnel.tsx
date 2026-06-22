import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { SettingsLetsEncryptChallengeProvider } from "@/lib/ui-api";
import {
  CertificateStatusRow,
  FormRow,
  LetsEncryptFields,
  NumberInput,
  Section,
  SelectInput,
  SelfSignedHint,
  SSL_SOURCE_OPTIONS,
  TextInput,
  useSettingsContext,
} from "../shared";

export function TunnelPage() {
  const {
    form,
    updateField,
    fieldError,
    certStatus,
    revealSecret,
    toggleRevealSecret,
  } = useSettingsContext();
  return (
    <Section title="Tunnel" id="settings-section-tunnel">
      <FormRow
        label="Tunnel"
        hint="Starts the public tunnel listener. Service publication and Web UI publication are configured below."
      >
        <Checkbox
          checked={form.tunnelEnabled}
          onCheckedChange={(v) => updateField("tunnelEnabled", v)}
          data-testid="settings-tunnel-enabled"
        >
          Enabled
        </Checkbox>
      </FormRow>

      {form.tunnelEnabled && (
        <>
          <FormRow
            label="Tunnel port"
            htmlFor="settings-tunnel-port"
            hint="Local bind port the tunnel listener binds to."
            error={fieldError("tunnel.port")}
          >
            <NumberInput
              id="settings-tunnel-port"
              value={form.tunnelPort}
              onChange={(v) => updateField("tunnelPort", v)}
              placeholder="5858"
              data-testid="settings-tunnel-port"
            />
          </FormRow>

          <FormRow
            label="Public URL port"
            htmlFor="settings-tunnel-public-port"
            hint="Port advertised in tunnel URLs. Leave blank to use the bind port. Set when WorktreeOS is behind a reverse proxy that fronts traffic on a different port (e.g. 443)."
            error={fieldError("tunnel.publicPort")}
          >
            <NumberInput
              id="settings-tunnel-public-port"
              value={form.tunnelPublicPort}
              onChange={(v) => updateField("tunnelPublicPort", v)}
              placeholder="443"
              data-testid="settings-tunnel-public-port"
            />
          </FormRow>

          <FormRow
            label="Tunnel domain"
            htmlFor="settings-tunnel-domain"
            hint="Root domain used to derive per-service subdomains, e.g. example.com."
            error={fieldError("tunnel.domain")}
          >
            <TextInput
              id="settings-tunnel-domain"
              value={form.tunnelDomain}
              onChange={(v) => updateField("tunnelDomain", v)}
              placeholder="example.com"
              data-testid="settings-tunnel-domain"
            />
          </FormRow>

          <FormRow
            label="Tunnel SSL"
            hint="Serve the tunnel listener over HTTPS."
          >
            <Checkbox
              checked={form.tunnelSslEnabled}
              onCheckedChange={(v) => updateField("tunnelSslEnabled", v)}
              data-testid="settings-tunnel-ssl-enabled"
            >
              Enabled
            </Checkbox>
          </FormRow>

          {form.tunnelSslEnabled && (
            <>
              <FormRow
                label="Tunnel SSL source"
                hint="Where the tunnel certificate comes from."
                error={fieldError("tunnel.ssl.source")}
              >
                <SelectInput
                  value={form.tunnelSslSource}
                  onChange={(v) => updateField("tunnelSslSource", v)}
                  options={SSL_SOURCE_OPTIONS}
                  data-testid="settings-tunnel-ssl-source"
                />
              </FormRow>

              {form.tunnelSslSource === "files" && (
                <>
                  <FormRow
                    label="Tunnel SSL cert path"
                    htmlFor="settings-tunnel-ssl-cert"
                    hint="Filesystem path to a PEM-encoded certificate."
                    error={fieldError("tunnel.ssl.cert")}
                  >
                    <TextInput
                      id="settings-tunnel-ssl-cert"
                      value={form.tunnelSslCert}
                      onChange={(v) => updateField("tunnelSslCert", v)}
                      placeholder="/etc/ssl/tunnel.crt"
                      data-testid="settings-tunnel-ssl-cert"
                    />
                  </FormRow>
                  <FormRow
                    label="Tunnel SSL key path"
                    htmlFor="settings-tunnel-ssl-key"
                    hint="Filesystem path to a PEM-encoded private key."
                    error={fieldError("tunnel.ssl.key")}
                  >
                    <TextInput
                      id="settings-tunnel-ssl-key"
                      value={form.tunnelSslKey}
                      onChange={(v) => updateField("tunnelSslKey", v)}
                      placeholder="/etc/ssl/tunnel.key"
                      data-testid="settings-tunnel-ssl-key"
                    />
                  </FormRow>
                </>
              )}

              {form.tunnelSslSource === "self-signed" && (
                <SelfSignedHint listener="tunnel" />
              )}

              {form.tunnelSslSource === "letsencrypt" && (
                <LetsEncryptFields
                  prefix="tunnel"
                  state={{
                    email: form.tunnelLeEmail,
                    provider: form.tunnelLeProvider,
                    create: form.tunnelLeCreate,
                    delete: form.tunnelLeDelete,
                    propagation: form.tunnelLePropagation,
                    cfTokenEnv: form.tunnelLeCfTokenEnv,
                    cfApiToken: form.tunnelLeCfApiToken,
                    cfZoneId: form.tunnelLeCfZoneId,
                  }}
                  setField={(key, value) => {
                    if (key === "email") updateField("tunnelLeEmail", value as string);
                    else if (key === "provider")
                      updateField(
                        "tunnelLeProvider",
                        value as SettingsLetsEncryptChallengeProvider,
                      );
                    else if (key === "create") updateField("tunnelLeCreate", value as string);
                    else if (key === "delete") updateField("tunnelLeDelete", value as string);
                    else if (key === "propagation")
                      updateField("tunnelLePropagation", value as string);
                    else if (key === "cfTokenEnv")
                      updateField("tunnelLeCfTokenEnv", value as string);
                    else if (key === "cfApiToken")
                      updateField("tunnelLeCfApiToken", value as string);
                    else if (key === "cfZoneId")
                      updateField("tunnelLeCfZoneId", value as string);
                  }}
                  fieldError={fieldError}
                />
              )}
            </>
          )}

          {certStatus?.tunnel && (
            <CertificateStatusRow status={certStatus.tunnel} listener="tunnel" />
          )}

          <FormRow
            label="Public Web UI"
            hint="Publish the management Web UI through the tunnel listener under a subdomain of tunnel.domain."
          >
            <Checkbox
              checked={form.tunnelWebUiEnabled}
              onCheckedChange={(v) => updateField("tunnelWebUiEnabled", v)}
              data-testid="settings-tunnel-webui-enabled"
            >
              Enabled
            </Checkbox>
          </FormRow>

          {form.tunnelWebUiEnabled && (
            <>
              <FormRow
                label="Web UI subdomain"
                htmlFor="settings-tunnel-webui-subdomain"
                hint="DNS label (e.g. wos) or full hostname under tunnel.domain (e.g. wos.example.com)."
                error={fieldError("tunnel.webUi.subdomain")}
              >
                <TextInput
                  id="settings-tunnel-webui-subdomain"
                  value={form.tunnelWebUiSubdomain}
                  onChange={(v) => updateField("tunnelWebUiSubdomain", v)}
                  placeholder="wos"
                  data-testid="settings-tunnel-webui-subdomain"
                />
              </FormRow>

              <FormRow
                label="Web UI secret"
                htmlFor="settings-tunnel-webui-secret"
                hint="Shared secret used to sign the public Web UI auth cookie. Stored in plaintext."
                error={fieldError("tunnel.webUi.secret")}
              >
                <div className="flex items-center gap-2">
                  <TextInput
                    id="settings-tunnel-webui-secret"
                    type={revealSecret ? "text" : "password"}
                    value={form.tunnelWebUiSecret}
                    onChange={(v) => updateField("tunnelWebUiSecret", v)}
                    placeholder="secret…"
                    data-testid="settings-tunnel-webui-secret"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={toggleRevealSecret}
                    aria-label={revealSecret ? "Hide secret" : "Show secret"}
                  >
                    {revealSecret ? (
                      <EyeOff className="size-[14px]" />
                    ) : (
                      <Eye className="size-[14px]" />
                    )}
                  </Button>
                </div>
              </FormRow>

              <FormRow
                label="Web UI terminal access"
                hint="When enabled, authenticated public sessions may open terminals into worktrees."
              >
                <Checkbox
                  checked={form.tunnelWebUiTerminalEnabled}
                  onCheckedChange={(v) =>
                    updateField("tunnelWebUiTerminalEnabled", v)
                  }
                  data-testid="settings-tunnel-webui-terminal"
                >
                  Enabled
                </Checkbox>
              </FormRow>

              <FormRow
                label="Web UI IP whitelist"
                htmlFor="settings-tunnel-webui-whitelist"
                hint="One IP per line. Empty allows all clients."
                error={fieldError("tunnel.webUi.whitelistIps")}
              >
                <TextInput
                  id="settings-tunnel-webui-whitelist"
                  value={form.tunnelWebUiWhitelist}
                  onChange={(v) => updateField("tunnelWebUiWhitelist", v)}
                  placeholder=""
                  data-testid="settings-tunnel-webui-whitelist"
                />
              </FormRow>
            </>
          )}

          <FormRow
            label="Service tunnels"
            hint="Publish managed service ports as tunnel routes during wos up."
          >
            <Checkbox
              checked={form.serviceTunnelsEnabled}
              onCheckedChange={(v) => updateField("serviceTunnelsEnabled", v)}
              data-testid="settings-service-tunnels-enabled"
            >
              Enabled
            </Checkbox>
          </FormRow>

          {form.serviceTunnelsEnabled && (
            <FormRow
              label="Service tunnel IP whitelist"
              htmlFor="settings-service-tunnels-whitelist"
              hint="One IP per line. Empty allows all clients."
              error={fieldError("tunnel.serviceTunnels.whitelistIps")}
            >
              <TextInput
                id="settings-service-tunnels-whitelist"
                value={form.serviceTunnelsWhitelist}
                onChange={(v) => updateField("serviceTunnelsWhitelist", v)}
                placeholder=""
                data-testid="settings-service-tunnels-whitelist"
              />
            </FormRow>
          )}
        </>
      )}
    </Section>
  );
}
