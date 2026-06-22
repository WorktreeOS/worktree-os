import { FileText, Rocket, ScrollText } from "lucide-react";
import { channelLabel, LogsView } from "@/components/logs-view";
import type {
  LogChannel,
  WorktreeDetailResponse,
} from "@/lib/ui-api";
import { cn } from "@/lib/utils";

export function LogsPanelBody({
  detail,
  channel,
  onSelectChannel,
}: {
  detail: WorktreeDetailResponse;
  channel: LogChannel;
  onSelectChannel: (channel: LogChannel) => void;
}) {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="logs-panel"
      data-channel={channel}
    >
      <LogsChannelSwitcher
        detail={detail}
        activeChannel={channel}
        onSelect={onSelectChannel}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-2.5">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-[oklch(0.13_0.012_260)]">
          <div className="flex h-9 items-center gap-2 border-b border-white/10 bg-white/[0.02] px-3">
            <ScrollText className="h-3.5 w-3.5 text-zinc-300" />
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-400">
              logs
            </span>
            <span className="font-mono text-[11.5px] text-zinc-100">
              {channelLabel(channel)}
            </span>
            <span className="status-dot status-dot--active status-dot--pulse" />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1">
            <LogsView
              sessionName={detail.worktree.sessionName}
              channel={channel}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function LogsChannelSwitcher({
  detail,
  activeChannel,
  onSelect,
}: {
  detail: WorktreeDetailResponse;
  activeChannel: LogChannel;
  onSelect: (channel: LogChannel) => void;
}) {
  return (
    <div
      className="flex items-center gap-1.5 overflow-x-auto border-b border-border/60 bg-card/40 px-2 py-1.5"
      data-testid="logs-channel-switcher"
    >
      <ChannelChip
        active={activeChannel === "deployment"}
        onClick={() => onSelect("deployment")}
        testId="logs-channel-deployment"
      >
        <Rocket className="h-3 w-3" />
        deployment
      </ChannelChip>
      <ChannelChip
        active={activeChannel === "init"}
        onClick={() => onSelect("init")}
        testId="logs-channel-init"
      >
        <FileText className="h-3 w-3" />
        init
      </ChannelChip>
      {detail.services.map((svc) => {
        const channel: LogChannel = `service:${svc.service}`;
        const isRunning = svc.state === "running";
        const tone: "active" | "muted" | "warn" = isRunning
          ? "active"
          : svc.state === "exited" || svc.state === "stopped"
            ? "muted"
            : "warn";
        return (
          <ChannelChip
            key={svc.service}
            active={activeChannel === channel}
            onClick={() => onSelect(channel)}
            testId={`logs-channel-service:${svc.service}`}
          >
            <span className={cn("status-dot", `status-dot--${tone}`)} />
            {svc.service}
          </ChannelChip>
        );
      })}
    </div>
  );
}

function ChannelChip({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[11px] transition-colors",
        active
          ? "border-foreground/30 bg-accent text-foreground"
          : "border-border bg-background text-muted-foreground hover:border-foreground/20 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
