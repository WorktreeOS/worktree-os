import type { LogChannel, LogStream } from "@worktreeos/core/events";

export interface LogLine {
  stream: LogStream;
  text: string;
}

export class LogBuffer {
  private readonly lines: LogLine[] = [];
  private partial: { stream: LogStream; text: string } | null = null;

  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error("LogBuffer capacity must be positive");
  }

  append(stream: LogStream, chunk: string): void {
    let text = chunk;
    if (this.partial && this.partial.stream === stream) {
      text = this.partial.text + text;
      this.partial = null;
    } else if (this.partial) {
      // Different stream interrupts pending partial line — flush it as-is.
      this.lines.push({ stream: this.partial.stream, text: this.partial.text });
      this.partial = null;
      this.enforceCap();
    }
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10 /* \n */) {
        const line = text.slice(start, i);
        this.lines.push({ stream, text: line });
        this.enforceCap();
        start = i + 1;
      }
    }
    if (start < text.length) {
      this.partial = { stream, text: text.slice(start) };
    }
  }

  snapshot(): LogLine[] {
    const out = this.lines.slice();
    if (this.partial) out.push({ stream: this.partial.stream, text: this.partial.text });
    return out;
  }

  size(): number {
    return this.lines.length + (this.partial ? 1 : 0);
  }

  clear(): void {
    this.lines.length = 0;
    this.partial = null;
  }

  private enforceCap(): void {
    const overflow = this.lines.length - this.capacity;
    if (overflow > 0) this.lines.splice(0, overflow);
  }
}

export interface ChannelDescriptor {
  id: LogChannel;
  label: string;
}

export class ChannelRegistry {
  private readonly buffers = new Map<LogChannel, LogBuffer>();
  private readonly order: LogChannel[] = [];
  private readonly labels = new Map<LogChannel, string>();
  private activeIdx = 0;

  constructor(
    private readonly capacity: number,
    initial: ChannelDescriptor[] = [],
  ) {
    for (const ch of initial) this.ensure(ch.id, ch.label);
  }

  ensure(id: LogChannel, label?: string): LogBuffer {
    let buf = this.buffers.get(id);
    if (!buf) {
      buf = new LogBuffer(this.capacity);
      this.buffers.set(id, buf);
      this.order.push(id);
    }
    if (label !== undefined) this.labels.set(id, label);
    else if (!this.labels.has(id)) this.labels.set(id, id);
    return buf;
  }

  append(id: LogChannel, stream: LogStream, chunk: string): void {
    this.ensure(id).append(stream, chunk);
  }

  channels(): ChannelDescriptor[] {
    return this.order.map((id) => ({ id, label: this.labels.get(id) ?? id }));
  }

  active(): ChannelDescriptor {
    const id = this.order[this.activeIdx] ?? this.order[0];
    if (!id) throw new Error("ChannelRegistry has no channels");
    return { id, label: this.labels.get(id) ?? id };
  }

  setActive(id: LogChannel): boolean {
    const idx = this.order.indexOf(id);
    if (idx < 0) return false;
    this.activeIdx = idx;
    return true;
  }

  next(): ChannelDescriptor {
    if (this.order.length === 0) throw new Error("ChannelRegistry has no channels");
    this.activeIdx = (this.activeIdx + 1) % this.order.length;
    return this.active();
  }

  prev(): ChannelDescriptor {
    if (this.order.length === 0) throw new Error("ChannelRegistry has no channels");
    this.activeIdx = (this.activeIdx - 1 + this.order.length) % this.order.length;
    return this.active();
  }

  snapshot(id: LogChannel): LogLine[] {
    return this.buffers.get(id)?.snapshot() ?? [];
  }
}
