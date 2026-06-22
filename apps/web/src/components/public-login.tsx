import { useState, type FormEvent } from "react";
import { usePublicAuth } from "@/lib/public-auth-context";
import { UiUnauthorizedError } from "@/lib/ui-api";

export function PublicLoginView() {
  const { login } = usePublicAuth();
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(secret);
      setSecret("");
    } catch (err) {
      if (err instanceof UiUnauthorizedError) {
        setError("Invalid secret");
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow"
      >
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">WorktreeOS</h1>
          <p className="text-sm text-muted-foreground">
            Enter the configured access secret to continue.
          </p>
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Secret
          </span>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            disabled={submitting}
            data-testid="public-login-secret"
          />
        </label>
        {error ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            data-testid="public-login-error"
          >
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={submitting || secret.length === 0}
          className="inline-flex w-full items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
