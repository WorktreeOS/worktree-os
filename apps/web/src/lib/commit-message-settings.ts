import type {
  SettingsCommitMessagesDraft,
  SettingsConfigSnapshot,
} from "./ui-api";

/**
 * Pure derivation for the Settings AI page's default commit-message provider
 * control. Kept out of the `.tsx` form module so it can be unit-tested without
 * a DOM (per the web no-render-tests convention).
 */
export interface CommitMessageSettingsFields {
  /** Provider name; empty string means "no default". */
  provider: string;
  /** Optional model id. */
  model: string;
}

/** Derive the commit-message form fields from a settings snapshot. */
export function commitMessageFieldsFromSnapshot(
  snap: Pick<SettingsConfigSnapshot, "raw" | "effective">,
): CommitMessageSettingsFields {
  const raw = snap.raw?.commitMessages;
  const eff = snap.effective.commitMessages;
  return {
    provider: raw?.provider ?? eff?.provider ?? "",
    model: raw?.model ?? eff?.model ?? "",
  };
}

/**
 * Build the `commitMessages` draft from the form fields. Always returns an
 * object (possibly empty) so a cleared selection round-trips as an explicit
 * clear instead of being preserved from disk.
 */
export function commitMessagesDraftFromFields(
  fields: CommitMessageSettingsFields,
): SettingsCommitMessagesDraft {
  const draft: SettingsCommitMessagesDraft = {};
  const provider = fields.provider.trim();
  const model = fields.model.trim();
  if (provider.length > 0) draft.provider = provider;
  // A model without a provider is meaningless; only persist it alongside one.
  if (provider.length > 0 && model.length > 0) draft.model = model;
  return draft;
}

/**
 * Whether the commit-message provider field still names a configured provider.
 * Used to surface a stale-selection hint after a provider is renamed/removed.
 */
export function commitMessageProviderIsKnown(
  providerName: string,
  configuredNames: ReadonlyArray<string>,
): boolean {
  if (providerName.length === 0) return true;
  return configuredNames.includes(providerName);
}
