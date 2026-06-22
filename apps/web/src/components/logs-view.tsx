import { useEffect, useRef, useState } from "react";
import { useUiApi } from "@/lib/api-context";
import type { LogChannel, SessionLogEnvelope } from "@/lib/ui-api";
import { cn } from "@/lib/utils";

export function LogsView({
  sessionName,
  channel,
  compact,
}: {
  sessionName: string;
  channel: LogChannel;
  compact?: boolean;
}) {
  const api = useUiApi();
  const [lines, setLines] = useState<SessionLogEnvelope[]>([]);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    setLines([]);
    setError(null);
    (async () => {
      try {
        for await (const env of api.streamWorktreeLogs(sessionName, {
          signal: abort.signal,
          channel,
        })) {
          setLines((prev) => {
            const next =
              prev.length > 2000 ? prev.slice(-2000) : prev.slice();
            next.push(env);
            return next;
          });
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setError((e as Error).message);
        }
      }
    })();
    return () => abort.abort();
  }, [api, sessionName, channel]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const emptyLabel =
    channel === "deployment"
      ? "Deployment logs will appear as the deploy progresses."
      : channel === "init"
        ? "Init logs will appear when the deployment starts initialization."
        : "Logs will appear as soon as this service produces output.";

  return (
    <div
      className="relative flex h-full min-w-0 flex-1 flex-col"
      data-testid="logs-view"
    >
      {error && (
        <div className="border-b border-[color:color-mix(in_oklch,var(--signal-error)_40%,transparent)] bg-[color:var(--signal-error-soft)] px-4 py-2 font-mono text-[11px] text-[color:var(--signal-error)]">
          <span className="uppercase tracking-[0.18em]">error</span>
          <span className="mx-2 text-foreground/30">·</span>
          {error}
        </div>
      )}
      <div
        ref={containerRef}
        className={cn(
          "min-w-0 flex-1 overflow-auto bg-[oklch(0.13_0.012_260)] font-mono text-[12px] leading-[1.6] text-zinc-100",
          compact ? "p-2.5" : "p-4",
        )}
      >
        {lines.length === 0 ? (
          <div className="flex h-full items-center justify-center text-zinc-500">
            <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em]">
              <span className="status-dot status-dot--info status-dot--pulse" />
              waiting for output
            </span>
            <span className="ml-3 text-[11.5px] normal-case tracking-normal text-zinc-600">
              {emptyLabel}
            </span>
          </div>
        ) : (
          lines.map((line) => (
            <div
              key={`${line.sequence}-${line.service}`}
              className={cn(
                "whitespace-pre-wrap [overflow-wrap:anywhere]",
                line.stream === "stderr"
                  ? "text-[color:var(--signal-error)]"
                  : "text-zinc-100",
              )}
            >
              <span className="mr-2 text-zinc-400">[{line.service}]</span>
              {line.chunk.replace(/\n$/, "")}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function channelLabel(channel: LogChannel): string {
  if (channel === "deployment") return "deployment";
  if (channel === "init") return "init";
  return channel.slice("service:".length);
}
