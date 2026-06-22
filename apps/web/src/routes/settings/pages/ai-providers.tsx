import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { Document } from "@/routes/worktree/document";
import { Button } from "@/components/ui/button";
import { Ic } from "@/components/ui/inline-code";
import {
  AI_PROVIDER_TYPE_OPTIONS,
  FormRow,
  SelectInput,
  TextInput,
  useSettingsContext,
} from "../shared";

export function AiProvidersPage() {
  const {
    form,
    snapshot,
    fieldError,
    providerFieldError,
    providerModelsError,
    updateField,
    updateProvider,
    addProvider,
    removeProvider,
    revealedKeys,
    toggleReveal,
  } = useSettingsContext();
  const hasProviders = form.aiProviders.length > 0;
  const providerNames = Array.from(
    new Set(
      form.aiProviders.map((p) => p.name.trim()).filter((n) => n.length > 0),
    ),
  );
  const commitProviderOptions = [
    { value: "", label: "None" },
    ...providerNames.map((n) => ({ value: n, label: n })),
  ];
  return (
    <Document.Section
      title="AI providers"
      id="settings-section-ai-providers"
      className="scroll-mt-6"
    >
      <div className="flex flex-col gap-4 py-3.5">
        <p className="text-[12.5px] text-[color:var(--muted-foreground)] m-0">
          Configure LLM API providers for AI-powered workflows. API keys are
          stored in plaintext in <Ic>{snapshot.path}</Ic> and are only
          accessible from this local machine.
        </p>
        {fieldError("aiProviders") && (
          <p
            className="text-[12.5px] text-[color:var(--bad)] m-0"
            data-testid="settings-field-error"
          >
            {fieldError("aiProviders")}
          </p>
        )}
        {form.aiProviders.length === 0 && (
          <p
            className="text-[13px] text-[color:var(--ink-2)] m-0"
            data-testid="settings-ai-providers-empty"
          >
            No providers configured yet.
          </p>
        )}
        {form.aiProviders.map((provider, index) => (
          <div
            key={index}
            className="rounded-md border border-[color:var(--hair-2)] px-3.5"
            data-testid="settings-ai-provider"
          >
            <div className="flex items-center justify-between py-3">
              <span className="text-[13px] font-medium text-[color:var(--ink)]">
                {provider.name.trim().length > 0
                  ? provider.name.trim()
                  : `Provider ${index + 1}`}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeProvider(index)}
                aria-label="Remove provider"
                data-testid="settings-ai-provider-remove"
              >
                <Trash2 className="size-[14px]" />
                Remove
              </Button>
            </div>
            <div className="flex flex-col divide-y divide-[color:var(--hair)] border-t border-[color:var(--hair)]">
              <FormRow
                label="Type"
                hint="Provider API dialect. Use the *-compatible types for self-hosted or third-party gateways."
                error={providerFieldError(index, "type")}
              >
                <SelectInput
                  value={provider.type}
                  onChange={(v) => updateProvider(index, { type: v })}
                  options={AI_PROVIDER_TYPE_OPTIONS}
                  data-testid="settings-ai-provider-type"
                />
              </FormRow>
              <FormRow
                label="Name (optional)"
                hint="Display name to tell providers of the same type apart."
                error={providerFieldError(index, "name")}
              >
                <TextInput
                  value={provider.name}
                  onChange={(v) => updateProvider(index, { name: v })}
                  placeholder="Work"
                  data-testid="settings-ai-provider-name"
                />
              </FormRow>
              <FormRow
                label="API key"
                hint="Required. Stored in plaintext in config.json."
                error={providerFieldError(index, "apiKey")}
              >
                <div className="flex items-center gap-2">
                  <TextInput
                    type={revealedKeys[index] ? "text" : "password"}
                    value={provider.apiKey}
                    onChange={(v) => updateProvider(index, { apiKey: v })}
                    placeholder="sk-…"
                    data-testid="settings-ai-provider-api-key"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleReveal(index)}
                    aria-label={
                      revealedKeys[index] ? "Hide API key" : "Show API key"
                    }
                    data-testid="settings-ai-provider-reveal"
                  >
                    {revealedKeys[index] ? (
                      <EyeOff className="size-[14px]" />
                    ) : (
                      <Eye className="size-[14px]" />
                    )}
                  </Button>
                </div>
              </FormRow>
              <FormRow
                label="Base URL (optional)"
                hint="Override the provider API base URL. Recommended for *-compatible gateways."
                error={providerFieldError(index, "baseUrl")}
              >
                <TextInput
                  value={provider.baseUrl}
                  onChange={(v) => updateProvider(index, { baseUrl: v })}
                  placeholder="https://api.openai.com/v1"
                  data-testid="settings-ai-provider-base-url"
                />
              </FormRow>
              <FormRow
                label="Models (optional)"
                hint="Comma- or newline-separated model IDs. Order is preserved. Treated as availability hints only."
                error={providerModelsError(index)}
              >
                <TextInput
                  value={provider.models}
                  onChange={(v) => updateProvider(index, { models: v })}
                  placeholder="gpt-4.1, gpt-4.1-mini"
                  data-testid="settings-ai-provider-models"
                />
              </FormRow>
            </div>
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={addProvider}
            data-testid="settings-ai-provider-add"
          >
            <Plus className="size-[14px]" />
            Add provider
          </Button>
        </div>

        <div className="flex flex-col gap-1 border-t border-[color:var(--hair)] pt-4">
          <h3 className="m-0 text-[13.5px] font-semibold text-[color:var(--ink)]">
            Default commit message provider
          </h3>
          <p className="m-0 text-[12.5px] text-[color:var(--muted-foreground)]">
            Used by the Review tab to write commit messages from the staged
            diff. A repository <Ic>.wos/config.yaml</Ic> can override this per
            repo.
          </p>
        </div>
        {!hasProviders ? (
          <p
            className="m-0 text-[13px] text-[color:var(--ink-2)]"
            data-testid="settings-commit-message-no-providers"
          >
            Add an AI provider above before choosing a default commit-message
            provider.
          </p>
        ) : providerNames.length === 0 ? (
          <p
            className="m-0 text-[13px] text-[color:var(--ink-2)]"
            data-testid="settings-commit-message-unnamed"
          >
            Give a provider a name above to select it as the default
            commit-message provider.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-[color:var(--hair)] border-y border-[color:var(--hair)]">
            <FormRow
              label="Provider"
              hint="The provider used to generate commit messages by default."
              error={fieldError("commitMessages.provider")}
            >
              <SelectInput
                value={form.commitMessageProvider}
                onChange={(v) => updateField("commitMessageProvider", v)}
                options={commitProviderOptions}
                data-testid="settings-commit-message-provider"
              />
            </FormRow>
            <FormRow
              label="Model (optional)"
              hint="Model id for generation. Leave blank to use the provider's first model."
              error={fieldError("commitMessages.model")}
            >
              <TextInput
                value={form.commitMessageModel}
                onChange={(v) => updateField("commitMessageModel", v)}
                placeholder="claude-opus-4-8"
                data-testid="settings-commit-message-model"
              />
            </FormRow>
          </div>
        )}
      </div>
    </Document.Section>
  );
}
