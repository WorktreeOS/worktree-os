/**
 * Mission Control snapshot stream client.
 *
 * Opens ONE `EventSource` against the daemon's snapshot fan-out endpoint and
 * coalesces incoming `snapshot` frames to a single render per animation frame
 * (the daemon may push many panes within one cadence tick; the wall should
 * repaint at most once per frame). Reconnects when the subscribed id set or
 * cadence changes — the cadence is a server-side request parameter.
 */

import type {
  TerminalScreenSnapshotResult,
  TerminalSessionMetadata,
} from "../terminal-protocol";

export interface SnapshotFrame {
  id: string;
  session: TerminalSessionMetadata;
  snapshot: TerminalScreenSnapshotResult;
}

type Scheduler = (cb: () => void) => void;

const defaultScheduler: Scheduler = (cb) => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => cb());
  else setTimeout(cb, 16);
};

/**
 * Accumulates the latest frame per session id and flushes them together at
 * most once per scheduler tick. Pure of any transport so it is unit-testable
 * with a manual scheduler.
 */
export class SnapshotCoalescer {
  private readonly latest = new Map<string, SnapshotFrame>();
  private dirty = false;
  private scheduled = false;

  constructor(
    private readonly onFlush: (latest: ReadonlyMap<string, SnapshotFrame>) => void,
    private readonly schedule: Scheduler = defaultScheduler,
  ) {}

  push(frame: SnapshotFrame): void {
    this.latest.set(frame.id, frame);
    this.dirty = true;
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => this.flush());
  }

  private flush(): void {
    this.scheduled = false;
    if (!this.dirty) return;
    this.dirty = false;
    this.onFlush(this.latest);
  }

  get(): ReadonlyMap<string, SnapshotFrame> {
    return this.latest;
  }

  remove(id: string): void {
    this.latest.delete(id);
  }

  clear(): void {
    this.latest.clear();
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class SnapshotStreamClient {
  private es: EventSource | null = null;
  private readonly coalescer: SnapshotCoalescer;
  private currentIds: string[] = [];
  private currentCadence = 0;

  constructor(
    private readonly streamUrl: (ids: string[], cadenceMs: number) => string,
    onFrames: (latest: ReadonlyMap<string, SnapshotFrame>) => void,
    scheduler?: Scheduler,
  ) {
    this.coalescer = new SnapshotCoalescer(onFrames, scheduler);
  }

  /**
   * (Re)subscribe to the snapshot stream for a set of session ids at a cadence.
   * A no-op when neither changed; otherwise the EventSource is reopened (the
   * cadence is a server parameter and the id set is fixed per connection).
   */
  subscribe(ids: string[], cadenceMs: number): void {
    const sorted = [...ids].sort();
    if (
      this.es &&
      sameIds(sorted, this.currentIds) &&
      cadenceMs === this.currentCadence
    ) {
      return;
    }
    this.currentIds = sorted;
    this.currentCadence = cadenceMs;
    this.closeSource();
    // Drop coalesced frames for sessions we no longer track.
    for (const id of [...this.coalescer.get().keys()]) {
      if (!sorted.includes(id)) this.coalescer.remove(id);
    }
    if (sorted.length === 0) return;
    if (typeof EventSource === "undefined") return;
    const es = new EventSource(this.streamUrl(sorted, cadenceMs), {
      withCredentials: true,
    });
    es.addEventListener("snapshot", (ev) => {
      try {
        const frame = JSON.parse((ev as MessageEvent).data) as SnapshotFrame;
        if (frame && typeof frame.id === "string") this.coalescer.push(frame);
      } catch {
        /* ignore malformed frame */
      }
    });
    this.es = es;
  }

  private closeSource(): void {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
  }

  close(): void {
    this.closeSource();
    this.coalescer.clear();
  }
}
