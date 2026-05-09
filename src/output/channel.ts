import * as vscode from 'vscode';
import { prefixLines, timestamp } from './formatter.js';

export interface OutputEvent {
  kind: 'header' | 'line' | 'stdout' | 'stderr' | 'info' | 'warn' | 'error';
  serverName?: string;
  text: string;
  ts: number;
}

/**
 * Aggregated OutputChannel writer for batch operations.
 *
 * Streamed chunks are buffered per-server until a newline arrives so we
 * never emit partial lines (which would interleave badly across servers).
 * Also: a `FLUSH_WINDOW_MS` debounce coalesces chunks across servers and
 * drains them in **config order** rather than ssh2 arrival order. So
 * `uptime` on three servers produces output in the same order as the
 * server list — even though all three replies arrive within ~50ms of
 * each other in arrival-time-random order.
 */
const FLUSH_WINDOW_MS = 100;

export class OutputManager implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private readonly buffers = new Map<string, { stdout: string; stderr: string }>();
  private readonly emitter = new vscode.EventEmitter<OutputEvent>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Server names in config order. Drives flush ordering. Updated by
   *  external code on every config change. */
  private serverOrder: string[] = [];
  /** Fires after each line/header/stream event so external surfaces (e.g. the webview) can mirror. */
  readonly onEvent = this.emitter.event;

  constructor() {
    this.channel = vscode.window.createOutputChannel('SSH Fleet');
  }

  /** Sync the order used to drain pending streams. Called whenever the
   *  active config changes — pass `config.servers.map(s => s.name)`. */
  setServerOrder(names: string[]): void {
    this.serverOrder = [...names];
  }

  show(): void {
    this.channel.show(true);
  }

  header(text: string): void {
    // Drain any pending stream chunks BEFORE the header — keeps "stream
    // lines, then header, then more stream lines" time-ordering at the
    // batch level. Otherwise an admin marker could land before lines
    // that semantically came earlier.
    this.flushPendingStreams();
    this.channel.appendLine(`──── ${timestamp()} ${text}`);
    this.emitter.fire({ kind: 'header', text, ts: Date.now() });
  }

  line(server: string, text: string): void {
    this.flushPendingStreams();
    this.channel.appendLine(`[${server}] ${timestamp()} │ ${text}`);
    this.emitter.fire({ kind: 'line', serverName: server, text, ts: Date.now() });
  }

  /**
   * Surface an informational, warning, or error line *inside the SSH Fleet
   * panel's current cmd-block* (not as a bottom-right toast). Use these
   * for results / validation messages that the operator triggered from
   * the panel UI — keeping feedback near the cause beats a corner toast.
   *
   * `serverName` is optional: provide it for per-server results so the
   * webview can colour-code by server; omit it for global messages.
   */
  info(text: string, serverName?: string): void {
    this.flushPendingStreams();
    this.channel.appendLine(`${timestamp()} │ ${text}`);
    const ev: OutputEvent = { kind: 'info', text, ts: Date.now() };
    if (serverName) ev.serverName = serverName;
    this.emitter.fire(ev);
  }

  warn(text: string, serverName?: string): void {
    this.flushPendingStreams();
    this.channel.appendLine(`${timestamp()} │ WARN ${text}`);
    const ev: OutputEvent = { kind: 'warn', text, ts: Date.now() };
    if (serverName) ev.serverName = serverName;
    this.emitter.fire(ev);
  }

  error(text: string, serverName?: string): void {
    this.flushPendingStreams();
    this.channel.appendLine(`${timestamp()} │ ERROR ${text}`);
    const ev: OutputEvent = { kind: 'error', text, ts: Date.now() };
    if (serverName) ev.serverName = serverName;
    this.emitter.fire(ev);
  }

  stream(server: string, chunk: string, kind: 'stdout' | 'stderr'): void {
    let entry = this.buffers.get(server);
    if (!entry) {
      entry = { stdout: '', stderr: '' };
      this.buffers.set(server, entry);
    }
    entry[kind] += chunk;
    // Don't drain immediately — schedule a debounced flush so chunks
    // from sibling servers can join this batch and we drain them all
    // in config order.
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushPendingStreams(), FLUSH_WINDOW_MS);
  }

  /** Drain all per-server line buffers. Iterates `serverOrder` first (so
   *  output appears in config order) then any servers we haven't seen
   *  in the order list (e.g. ad-hoc connections, recently-removed). */
  private flushPendingStreams(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const seen = new Set<string>();
    for (const name of this.serverOrder) {
      if (this.buffers.has(name)) {
        this.drain(name, 'stdout');
        this.drain(name, 'stderr');
        seen.add(name);
      }
    }
    for (const name of this.buffers.keys()) {
      if (!seen.has(name)) {
        this.drain(name, 'stdout');
        this.drain(name, 'stderr');
      }
    }
  }

  private drain(server: string, kind: 'stdout' | 'stderr'): void {
    const entry = this.buffers.get(server);
    if (!entry) {
      return;
    }
    const buf = entry[kind];
    const lastNl = buf.lastIndexOf('\n');
    if (lastNl < 0) {
      return;
    }
    const ready = buf.slice(0, lastNl + 1);
    entry[kind] = buf.slice(lastNl + 1);
    for (const out of prefixLines(server, ready, kind)) {
      this.channel.appendLine(out);
    }
    // Also emit per-line events for subscribers (webview etc.)
    for (const raw of ready.split('\n')) {
      if (raw === '') continue;
      this.emitter.fire({ kind, serverName: server, text: raw.replace(/\r$/, ''), ts: Date.now() });
    }
  }


  dispose(): void {
    this.channel.dispose();
    this.emitter.dispose();
  }
}
