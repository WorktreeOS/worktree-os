/**
 * Daemon-owned in-memory cache of wos-managed Docker container state.
 *
 * The cache lives inside the daemon process. It is populated by an initial
 * full sync at daemon startup, kept current by a Docker events subscription,
 * and self-healed by a periodic full resync.
 *
 * Readers (status, UI, session monitor, tunnel restoration validation, etc.)
 * pull a normalized snapshot keyed by container id. Snapshots are also
 * indexed by session name + service name for the most common access pattern.
 */
import {
  WOS_LABEL_HOME_HASH,
  WOS_LABEL_MANAGED,
  WOS_LABEL_SCHEMA,
  WOS_LABEL_SCHEMA_VALUE,
  stableWosHomeHash,
} from "@worktreeos/core/tunnel-metadata";
import {
  DockerClient,
  type DockerEvent,
  type DockerEventStream,
} from "./docker-client";
import {
  isInternalService,
  isManaged,
  normalizeInspect,
  normalizeListItem,
  normalizeStats,
  type WosContainerSnapshot,
} from "./docker-snapshot";

/** Default Docker events reconciliation interval (5 minutes). */
const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/** Default resource-stats sampling interval (matches the ~5s monitor tick). */
const DEFAULT_STATS_INTERVAL_MS = 5 * 1000;

export interface DockerStateStoreOptions {
  client?: DockerClient;
  homeHash?: string;
  /** Periodic full-sync interval. Set to 0 to disable reconciliation. */
  reconcileIntervalMs?: number;
  /**
   * Resource-stats sampling interval. Set to 0 to disable stats sampling
   * entirely (e.g. in tests that don't exercise usage).
   */
  statsIntervalMs?: number;
  /** Hook for tests/observability. Invoked after every cache mutation. */
  onChange?: (snapshot: WosContainerSnapshot, kind: "upsert" | "remove") => void;
  /** Hook called whenever a full sync completes. */
  onSync?: () => void;
  /** Optional logger for warnings/errors. */
  logger?: (level: "info" | "warn" | "error", msg: string, err?: unknown) => void;
}

export class DockerStateStore {
  private readonly client: DockerClient;
  private readonly homeHash: string;
  private readonly reconcileIntervalMs: number;
  private readonly statsIntervalMs: number;
  private readonly onChange?: (snapshot: WosContainerSnapshot, kind: "upsert" | "remove") => void;
  private readonly onSync?: () => void;
  private readonly logger: (level: "info" | "warn" | "error", msg: string, err?: unknown) => void;

  /** Container id -> snapshot. */
  private byId = new Map<string, WosContainerSnapshot>();

  private events?: DockerEventStream;
  private reconcileTimer?: ReturnType<typeof setTimeout>;
  private statsTimer?: ReturnType<typeof setTimeout>;
  private statsSampling = false;
  private started = false;
  private stopping = false;
  private lastSyncTime = 0;

  constructor(opts: DockerStateStoreOptions = {}) {
    this.client = opts.client ?? new DockerClient();
    this.homeHash = opts.homeHash ?? stableWosHomeHash();
    this.reconcileIntervalMs = opts.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.statsIntervalMs = opts.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS;
    this.onChange = opts.onChange;
    this.onSync = opts.onSync;
    this.logger =
      opts.logger ??
      ((level, msg) => {
        if (level === "error" || level === "warn") {
          console[level === "error" ? "error" : "warn"](`[docker-state] ${msg}`);
        }
      });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    try {
      await this.fullSync();
    } catch (e) {
      this.logger("warn", "initial Docker sync failed", e);
    }
    this.openEvents();
    this.scheduleReconcile();
    this.scheduleStats();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = undefined;
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = undefined;
    try {
      this.events?.abort();
    } catch {
      // ignore
    }
    this.events = undefined;
  }

  /**
   * True once at least one full sync has completed. Readers use this to decide
   * whether the cache is authoritative: before the first sync (Docker socket
   * unavailable, or daemon still starting) they fall back to `docker compose
   * ps`; afterwards an empty session slice means "no managed containers".
   */
  hasSynced(): boolean {
    return this.lastSyncTime > 0;
  }

  /** Force a full sync now. Useful after `up`/`down` so readers see fresh state. */
  async syncNow(): Promise<void> {
    try {
      await this.fullSync();
    } catch (e) {
      this.logger("warn", "syncNow failed", e);
    }
  }

  /** Returns all snapshots, including stopped containers, optionally filtered. */
  list(filter?: {
    sessionName?: string;
    projectName?: string;
    includeInternal?: boolean;
  }): WosContainerSnapshot[] {
    const out: WosContainerSnapshot[] = [];
    for (const snap of this.byId.values()) {
      if (filter?.sessionName && snap.sessionName !== filter.sessionName) continue;
      if (filter?.projectName && snap.projectName !== filter.projectName) continue;
      if (!filter?.includeInternal && isInternalService(snap)) continue;
      out.push(snap);
    }
    return out;
  }

  /** Find the current managed container for a (session, service) tuple. */
  findCurrent(
    sessionName: string,
    serviceName: string,
  ): WosContainerSnapshot | undefined {
    let best: WosContainerSnapshot | undefined;
    for (const snap of this.byId.values()) {
      if (snap.sessionName !== sessionName) continue;
      if (snap.serviceName !== serviceName) continue;
      if (snap.removed) continue;
      // Prefer running containers when more than one matches.
      if (!best) {
        best = snap;
        continue;
      }
      const bestRunning = best.state === "running";
      const candidateRunning = snap.state === "running";
      if (candidateRunning && !bestRunning) best = snap;
    }
    return best;
  }

  // ----- internals -----

  private async fullSync(): Promise<void> {
    const labels = [`${WOS_LABEL_MANAGED}=true`, `${WOS_LABEL_HOME_HASH}=${this.homeHash}`];
    const items = await this.client.listContainers({ labels }, { all: true });
    const seen = new Set<string>();
    for (const item of items) {
      const snap = normalizeListItem(item);
      if (!snap) continue;
      if (snap.homeHash !== this.homeHash) continue;
      seen.add(snap.containerId);
      this.upsert(snap);
    }
    // Remove anything in cache the engine no longer reports.
    for (const id of Array.from(this.byId.keys())) {
      if (!seen.has(id)) {
        this.remove(id);
      }
    }
    this.lastSyncTime = Math.floor(Date.now() / 1000);
    this.onSync?.();
  }

  private upsert(snap: WosContainerSnapshot): void {
    // Preserve the latest sampled usage across list/inspect refreshes, which
    // never carry resource stats themselves. Stale usage is cleared once the
    // container is no longer running.
    const prev = this.byId.get(snap.containerId);
    let next = snap;
    if (snap.state === "running" && prev?.resourceUsage && !snap.resourceUsage) {
      next = { ...snap, resourceUsage: prev.resourceUsage };
    }
    this.byId.set(next.containerId, next);
    this.onChange?.(next, "upsert");
  }

  private remove(id: string): void {
    const snap = this.byId.get(id);
    if (!snap) return;
    const removed: WosContainerSnapshot = { ...snap, removed: true };
    this.byId.delete(id);
    this.onChange?.(removed, "remove");
  }

  private openEvents(): void {
    if (this.stopping) return;
    const since = this.lastSyncTime ? String(this.lastSyncTime) : undefined;
    const stream = this.client.openEvents(
      {
        labels: [
          `${WOS_LABEL_MANAGED}=true`,
          `${WOS_LABEL_HOME_HASH}=${this.homeHash}`,
        ],
      },
      since ? { since } : undefined,
    );
    this.events = stream;
    void this.consumeEvents(stream);
  }

  private async consumeEvents(stream: DockerEventStream): Promise<void> {
    try {
      for await (const ev of stream.events) {
        if (this.stopping) break;
        await this.applyEvent(ev);
      }
    } catch (e) {
      this.logger("warn", "Docker event stream error", e);
    }
    if (!this.stopping && this.events === stream) {
      this.events = undefined;
    }
  }

  private async applyEvent(ev: DockerEvent): Promise<void> {
    if (ev.Type !== "container") return;
    const id = ev.Actor?.ID;
    if (!id) return;
    const action = (ev.Action ?? "").toLowerCase();
    if (action === "destroy" || action === "remove") {
      this.remove(id);
      return;
    }
    // For every other action, prefer an inspect to get accurate state.
    try {
      const inspect = await this.client.inspectContainer(id);
      const labels = inspect.Config?.Labels ?? {};
      if (!isManaged(labels) || labels[WOS_LABEL_SCHEMA] !== WOS_LABEL_SCHEMA_VALUE) {
        // Container lost wos labels or isn't ours. Drop from cache.
        this.remove(id);
        return;
      }
      if (labels[WOS_LABEL_HOME_HASH] !== this.homeHash) {
        return;
      }
      const snap = normalizeInspect(inspect);
      if (!snap) {
        this.remove(id);
        return;
      }
      this.upsert(snap);
    } catch (e) {
      // Inspect can race with destroy; treat 404 as removal.
      const status = (e as { status?: number })?.status;
      if (status === 404) {
        this.remove(id);
      } else {
        this.logger("warn", `inspect after event failed for ${id}`, e);
      }
    }
  }

  private scheduleReconcile(): void {
    if (this.reconcileIntervalMs <= 0) return;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(async () => {
      if (this.stopping) return;
      try {
        this.events?.abort();
        this.events = undefined;
        await this.fullSync();
      } catch (e) {
        this.logger("warn", "reconcile fullSync failed", e);
      } finally {
        if (!this.stopping) {
          this.openEvents();
          this.scheduleReconcile();
        }
      }
    }, this.reconcileIntervalMs);
    if (typeof (this.reconcileTimer as { unref?: () => void }).unref === "function") {
      (this.reconcileTimer as { unref: () => void }).unref();
    }
  }

  private scheduleStats(): void {
    if (this.statsIntervalMs <= 0) return;
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = setTimeout(async () => {
      if (this.stopping) return;
      try {
        await this.sampleStats();
      } catch (e) {
        this.logger("warn", "stats sampling failed", e);
      } finally {
        if (!this.stopping) this.scheduleStats();
      }
    }, this.statsIntervalMs);
    if (typeof (this.statsTimer as { unref?: () => void }).unref === "function") {
      (this.statsTimer as { unref: () => void }).unref();
    }
  }

  /**
   * Sample resource stats for every running managed container concurrently and
   * attach the latest sample to the cached snapshot. A failure for one
   * container leaves its existing state (and prior usage, if any) untouched and
   * never aborts the batch. Public for tests; safe to call ad hoc.
   */
  async sampleStats(): Promise<void> {
    if (this.statsSampling) return; // avoid overlapping batches on a slow tick
    this.statsSampling = true;
    try {
      const running = Array.from(this.byId.values()).filter(
        (s) => s.state === "running" && !s.removed,
      );
      await Promise.all(
        running.map(async (snap) => {
          try {
            const raw = await this.client.statsContainer(snap.containerId);
            const usage = normalizeStats(raw);
            if (!usage) return;
            const current = this.byId.get(snap.containerId);
            if (!current || current.state !== "running") return;
            this.byId.set(snap.containerId, { ...current, resourceUsage: usage });
          } catch {
            // Leave existing state/usage intact; stats are best-effort.
          }
        }),
      );
    } finally {
      this.statsSampling = false;
    }
  }
}
