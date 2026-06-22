import { FormRow, Section, TextInput, useSettingsContext } from "../shared";

export function ServicesPage() {
  const { form, updateField, fieldError } = useSettingsContext();
  return (
    <Section title="Services" id="settings-section-services">
      <FormRow
        label="Service bind address"
        htmlFor="settings-service-bind"
        hint="Optional LAN address used to publish and advertise managed service ports. Compose publishes each port on both 127.0.0.1 and this address; URL/hostname templates use it in place of localhost. Advisory in shell mode. Leave empty to disable."
        error={fieldError("serviceBind")}
      >
        <TextInput
          id="settings-service-bind"
          value={form.serviceBind}
          onChange={(v) => updateField("serviceBind", v)}
          placeholder="192.168.1.18"
          data-testid="settings-service-bind"
        />
      </FormRow>
    </Section>
  );
}
