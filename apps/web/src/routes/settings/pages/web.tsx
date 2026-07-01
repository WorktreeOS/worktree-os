import { Checkbox } from "@/components/ui/checkbox";
import { Ic } from "@/components/ui/inline-code";
import { useSidebarVariant } from "@/lib/sidebar-variant";
import {
  FormRow,
  NumberInput,
  Section,
  TextInput,
  useSettingsContext,
} from "../shared";

export function WebPage() {
  const { form, updateField, fieldError } = useSettingsContext();
  return (
    <>
      <Section title="Web" id="settings-section-web">
        <FormRow
          label="Port"
          htmlFor="settings-web-port"
          hint="HTTP port the daemon listens on for the local web UI."
          error={fieldError("web.port")}
        >
          <NumberInput
            id="settings-web-port"
            value={form.webPort}
            onChange={(v) => updateField("webPort", v)}
            placeholder="4949"
            data-testid="settings-web-port"
          />
        </FormRow>

        <FormRow
          label="Host"
          htmlFor="settings-web-host"
          hint="Address the daemon web UI listener binds to. Use a LAN address (e.g. 192.168.1.18) to reach the dashboard from another device. Single address only; leave empty for 127.0.0.1."
          error={fieldError("web.host")}
        >
          <TextInput
            id="settings-web-host"
            value={form.webHost}
            onChange={(v) => updateField("webHost", v)}
            placeholder="127.0.0.1"
            data-testid="settings-web-host"
          />
        </FormRow>

        <p className="text-[13px] text-[color:var(--muted-foreground)] m-0 mt-2">
          The local Web UI listener is HTTP-only on loopback. To serve the
          dashboard over HTTPS to remote clients, enable <Ic>tunnel.webUi</Ic>{" "}
          below and configure HTTPS via <Ic>tunnel.ssl</Ic>.
        </p>
      </Section>

      <SidebarLayoutSection />
    </>
  );
}

/**
 * Per-device rail layout preference: the flat attention-stream + Worktrees
 * band (default), or the worktree tree. Stored client-side (localStorage) via
 * lib/sidebar-variant, separate from the server-persisted config above.
 */
function SidebarLayoutSection() {
  const [variant, setVariant] = useSidebarVariant();
  return (
    <Section title="Sidebar" id="settings-section-sidebar">
      <FormRow
        label="Layout"
        hint="Per-device. Stored on this device only — not synced through the daemon config."
      >
        <Checkbox
          checked={variant === "v4"}
          onCheckedChange={(checked) => setVariant(checked ? "v4" : "v3")}
          data-testid="settings-sidebar-variant"
        >
          Use the tree-style sidebar (experimental)
        </Checkbox>
      </FormRow>
    </Section>
  );
}
