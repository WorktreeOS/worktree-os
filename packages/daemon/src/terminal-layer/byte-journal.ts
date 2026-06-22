/**
 * Bounded byte journal for terminal session output.
 *
 * Every chunk produced by the PTY is appended with a monotonic sequence number
 * starting at 1 (sequence 0 is reserved for "no output yet"). The journal
 * retains chunks until the total retained bytes exceed `capacityBytes`, at
 * which point the oldest chunks are dropped. Sequence metadata is preserved
 * across drops so reattaching clients can detect replay gaps.
 *
 * A `CheckpointStore` slot is reserved for future server-side terminal screen
 * checkpoints. The first version of the runtime does not generate
 * checkpoints, but the interface lets a follow-up wire one in without
 * changing how attachments request replay.
 */

import type { TerminalReplayBoundary } from "./types";

export interface JournalChunk {
  seq: number;
  bytes: Uint8Array;
}

export interface ReplayPlan {
  /** True if the journal can serve every byte after `fromSeq`. */
  complete: boolean;
  /**
   * True if the requested `fromSeq` is older than the oldest retained chunk.
   * Clients SHOULD react to a `gap` by clearing their viewport before
   * accepting replay (and SHOULD prefer a checkpoint when present).
   */
  gap: boolean;
  /** Chunks to replay, in order. May be empty when nothing is retained. */
  chunks: JournalChunk[];
  /** Highest sequence number reached so far. */
  upToSeq: number;
}

export interface CheckpointSnapshot {
  seq: number;
  bytes: Uint8Array;
}

export interface CheckpointStore {
  /** Return the latest checkpoint, or null when none is available. */
  latest(): CheckpointSnapshot | null;
  /** Replace the current checkpoint. */
  put(snapshot: CheckpointSnapshot): void;
}

/** Null checkpoint store — used until real checkpoints are implemented. */
export class NullCheckpointStore implements CheckpointStore {
  latest(): CheckpointSnapshot | null {
    return null;
  }
  put(_snapshot: CheckpointSnapshot): void {
    /* no-op */
  }
}

export interface ByteJournalOptions {
  /** Maximum bytes retained in the journal. Defaults to 256 KiB. */
  capacityBytes?: number;
  /** Optional checkpoint store. Defaults to {@link NullCheckpointStore}. */
  checkpoints?: CheckpointStore;
}

const DEFAULT_CAPACITY = 256 * 1024;

export class ByteJournal {
  private readonly capacityBytes: number;
  private readonly chunks: JournalChunk[] = [];
  private retainedBytes = 0;
  private latestSeq = 0;
  /** Oldest sequence number EVER appended (regardless of drops). */
  private oldestEverSeq = 0;
  private readonly checkpoints: CheckpointStore;

  constructor(opts: ByteJournalOptions = {}) {
    this.capacityBytes = opts.capacityBytes ?? DEFAULT_CAPACITY;
    this.checkpoints = opts.checkpoints ?? new NullCheckpointStore();
  }

  /** Append a chunk, assign it the next monotonic sequence, return it. */
  append(bytes: Uint8Array): JournalChunk {
    if (bytes.byteLength === 0) {
      // Empty chunks don't advance the sequence — they would be invisible to
      // any consumer and only waste storage.
      return { seq: this.latestSeq, bytes };
    }
    this.latestSeq += 1;
    const chunk: JournalChunk = { seq: this.latestSeq, bytes };
    if (this.chunks.length === 0) {
      this.oldestEverSeq = chunk.seq;
    }
    this.chunks.push(chunk);
    this.retainedBytes += bytes.byteLength;
    this.evictUntilWithinCapacity();
    return chunk;
  }

  private evictUntilWithinCapacity(): void {
    while (this.retainedBytes > this.capacityBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (!dropped) break;
      this.retainedBytes -= dropped.bytes.byteLength;
    }
  }

  /** Latest output sequence number produced (0 when no output yet). */
  latestSequence(): number {
    return this.latestSeq;
  }

  /** Oldest sequence number still in the retained window (0 when empty). */
  firstRetainedSequence(): number {
    return this.chunks[0]?.seq ?? this.latestSeq;
  }

  /** Total bytes currently retained. */
  bytesRetained(): number {
    return this.retainedBytes;
  }

  /** Current replay boundary metadata for attachment handshakes. */
  boundary(): TerminalReplayBoundary {
    const latestCheckpoint = this.checkpoints.latest();
    return {
      firstRetainedSeq: this.firstRetainedSequence(),
      latestSeq: this.latestSeq,
      retainedBytes: this.retainedBytes,
      ...(latestCheckpoint ? { checkpointSeq: latestCheckpoint.seq } : {}),
    };
  }

  /**
   * Build the replay plan for a reattaching client. `fromSeq` is the last
   * sequence the client has already rendered:
   *
   * - `fromSeq === latestSeq` → nothing to replay.
   * - `fromSeq >= firstRetainedSequence-1` → chunks after `fromSeq` are
   *   replayed in order; `complete` is true.
   * - `fromSeq < firstRetainedSequence-1` and the journal has dropped older
   *   chunks → `gap` is true and `chunks` carry only the still-retained tail.
   */
  planReplay(fromSeq: number): ReplayPlan {
    const upToSeq = this.latestSeq;
    if (fromSeq >= upToSeq) {
      return { complete: true, gap: false, chunks: [], upToSeq };
    }
    if (this.chunks.length === 0) {
      return { complete: true, gap: false, chunks: [], upToSeq };
    }
    const firstRetained = this.chunks[0]!.seq;
    const gap = fromSeq + 1 < firstRetained;
    const slice: JournalChunk[] = [];
    for (const chunk of this.chunks) {
      if (chunk.seq > fromSeq) slice.push(chunk);
    }
    return { complete: !gap, gap, chunks: slice, upToSeq };
  }

  /** All currently retained chunks (defensive copy of the chunks array). */
  retainedChunks(): JournalChunk[] {
    return this.chunks.slice();
  }

  /** Replace the latest checkpoint. */
  putCheckpoint(snapshot: CheckpointSnapshot): void {
    this.checkpoints.put(snapshot);
  }

  /** Latest checkpoint snapshot. */
  latestCheckpoint(): CheckpointSnapshot | null {
    return this.checkpoints.latest();
  }

  /** Discard everything. Used during shutdown. */
  clear(): void {
    this.chunks.length = 0;
    this.retainedBytes = 0;
    this.oldestEverSeq = this.latestSeq;
  }
}
