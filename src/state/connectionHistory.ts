import * as vscode from 'vscode';

const STATE_KEY = 'ssh-fleet.connection-history.v1';

/**
 * Per-server last-connected timestamp store. Records the moment a server
 * transitions to `connected` so the TreeView can show "last connected
 * 5min ago" in tooltips and surface a "Recent Connections" quick-pick row.
 *
 * Keyed flat by server name (not per-config) — operators rarely reuse the
 * same name across configs, and a stale entry for a deleted server is
 * harmless (it just doesn't render anywhere).
 */
export class ConnectionHistoryStore implements vscode.Disposable {
  private cache: Record<string, number> = {};

  private readonly emitter = new vscode.EventEmitter<string>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly memento: vscode.Memento) {
    const raw = memento.get<unknown>(STATE_KEY);
    if (raw && typeof raw === 'object') {
      this.cache = raw as Record<string, number>;
    }
  }

  record(name: string): void {
    this.cache[name] = Date.now();
    void this.memento.update(STATE_KEY, this.cache);
    this.emitter.fire(name);
  }

  lastConnected(name: string): number | undefined {
    return this.cache[name];
  }

  /** All known server names sorted by most-recent connection first. */
  recent(limit?: number): { name: string; ts: number }[] {
    const list = Object.entries(this.cache)
      .map(([name, ts]) => ({ name, ts }))
      .sort((a, b) => b.ts - a.ts);
    return typeof limit === 'number' ? list.slice(0, limit) : list;
  }

  /** Drop entries for server names not in `known` — called after a config
   *  reload removes/renames servers. Best-effort cleanup; missing entries
   *  are harmless. */
  prune(known: ReadonlySet<string>): void {
    let changed = false;
    for (const name of Object.keys(this.cache)) {
      if (!known.has(name)) {
        delete this.cache[name];
        changed = true;
      }
    }
    if (changed) {
      void this.memento.update(STATE_KEY, this.cache);
      this.emitter.fire('__prune__');
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Human-readable "5min ago" / "2h ago" / "Jan 03" for a timestamp. */
export function formatLastConnected(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}
