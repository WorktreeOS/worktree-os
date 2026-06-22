import {
  FormRow,
  NumberInput,
  Section,
  TextInput,
  useSettingsContext,
} from "../shared";

export function HealthchecksPage() {
  const { form, updateField, fieldError } = useSettingsContext();
  return (
    <Section title="Healthcheck defaults" id="settings-section-healthchecks">
      <FormRow
        label="Timeout"
        htmlFor="settings-hc-timeout"
        hint="Total time allotted to bring up a port. Accepts ms numbers or duration strings (e.g. 5m, 30s, 2500)."
        error={fieldError("healthcheck.timeout")}
      >
        <TextInput
          id="settings-hc-timeout"
          value={form.hcTimeout}
          onChange={(v) => updateField("hcTimeout", v)}
          placeholder="3m"
          data-testid="settings-hc-timeout"
        />
      </FormRow>

      <FormRow
        label="Start period"
        htmlFor="settings-hc-start-period"
        hint="Grace period before failed probes begin counting against retries."
        error={fieldError("healthcheck.start_period")}
      >
        <TextInput
          id="settings-hc-start-period"
          value={form.hcStartPeriod}
          onChange={(v) => updateField("hcStartPeriod", v)}
          placeholder="15s"
          data-testid="settings-hc-start-period"
        />
      </FormRow>

      <FormRow
        label="Interval"
        htmlFor="settings-hc-interval"
        hint="Time between successive probe attempts."
        error={fieldError("healthcheck.interval")}
      >
        <TextInput
          id="settings-hc-interval"
          value={form.hcInterval}
          onChange={(v) => updateField("hcInterval", v)}
          placeholder="5s"
          data-testid="settings-hc-interval"
        />
      </FormRow>

      <FormRow
        label="Request timeout"
        htmlFor="settings-hc-request-timeout"
        hint="Per-HTTP-attempt timeout used during wait-mode polling."
        error={fieldError("healthcheck.request_timeout")}
      >
        <TextInput
          id="settings-hc-request-timeout"
          value={form.hcRequestTimeout}
          onChange={(v) => updateField("hcRequestTimeout", v)}
          placeholder="10s"
          data-testid="settings-hc-request-timeout"
        />
      </FormRow>

      <FormRow
        label="Retries"
        htmlFor="settings-hc-retries"
        hint="Maximum number of failed attempts after the start period."
        error={fieldError("healthcheck.retries")}
      >
        <NumberInput
          id="settings-hc-retries"
          value={form.hcRetries}
          onChange={(v) => updateField("hcRetries", v)}
          placeholder="20"
          data-testid="settings-hc-retries"
        />
      </FormRow>
    </Section>
  );
}
