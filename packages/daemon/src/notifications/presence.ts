/**
 * Daemon-side registry of focused browser clients. The notification engine
 * gates delivery on "is any client focused" rather than on terminal attachment.
 *
 * Only focused clients are held, keyed by a per-window `clientId` mapped to an
 * expiry timestamp. A `focused` report inserts or refreshes the expiry; an
 * `away` report removes the entry immediately; a lapsed heartbeat lets the entry
 * expire so a crashed or disconnected focused tab stops counting as present
 * after the TTL. The clock is passed in per call so tests stay deterministic
 * (mirroring the engine's `now` injection).
 */

/** Reported focus state of a single browser client. */
export type PresenceState = "focused" | "away";

/**
 * TTL for a focused client's presence. Sized to ≈2× the client heartbeat plus
 * slack so a single dropped beat does not flip presence to away.
 */
export const PRESENCE_TTL_MS = 45_000;

export class PresenceRegistry {
  /** clientId -> expiry timestamp (ms). Only focused clients are present. */
  private readonly clients = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? PRESENCE_TTL_MS;
  }

  /**
   * Record a client's reported focus state. `focused` inserts or refreshes the
   * client's expiry to `now + ttl`; `away` removes it immediately.
   */
  touch(clientId: string, state: PresenceState, now: number): void {
    if (state === "focused") {
      this.clients.set(clientId, now + this.ttlMs);
    } else {
      this.clients.delete(clientId);
    }
  }

  /** Whether any client is currently focused, pruning expired entries first. */
  hasFocusedClient(now: number): boolean {
    for (const [clientId, expiresAt] of this.clients) {
      if (expiresAt <= now) this.clients.delete(clientId);
    }
    return this.clients.size > 0;
  }
}
