import * as vscode from 'vscode';
import type { ConnectionRegistry, SshConnection } from '../ssh/connection.js';
import type { ConfigStore } from '../config/loader.js';
import { runRemoteCommand } from '../ssh/runner.js';
import { log } from '../util/logger.js';

export type BackupHealthStatus = 'unchecked' | 'ok' | 'failed';

export interface BackupHealthEntry {
  status: BackupHealthStatus;
  reason?: string;
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./@:%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Per-server health of the configured `autoBackup.backupDir`. On connect,
 * we run a tiny probe (`mkdir -p && [ -w ]`) and cache the result so the
 * UI can show "backup is set up but can't actually write" up front rather
 * than letting the operator find out per-command at run time.
 *
 * The cwd-bar's `🛡 backup` badge consumes the aggregated state: green
 * when every selected/connected server probes ok, gray when any failure.
 */
export class BackupHealthState implements vscode.Disposable {
  private readonly health = new Map<string, BackupHealthEntry>();
  private readonly emitter = new vscode.EventEmitter<string>();
  readonly onDidChange = this.emitter.event;
  private subs: vscode.Disposable[] = [];

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly config: ConfigStore
  ) {
    // Probe whenever a server's connection state changes. Only "now
    // connected" triggers a probe; other transitions clear the entry so
    // the UI doesn't show stale ok/failed for a server that's gone.
    this.subs.push(this.registry.onChange(name => {
      const conn = this.registry.get(name);
      if (!conn) {
        this.clear(name);
        return;
      }
      if (conn.state === 'connected') {
        void this.probe(conn);
      } else if (conn.state === 'idle' || conn.state === 'error') {
        this.clear(name);
      }
    }));

    // If the backup config flips at runtime (autoBackup.enabled toggled,
    // backupDir edited), invalidate every cached probe — they'd be
    // checking the wrong dir now.
    this.subs.push(this.config.onDidChange(() => {
      this.health.clear();
      this.emitter.fire('*');
      // Re-probe currently-connected servers under the new config.
      for (const c of this.registry.list()) {
        if (c.state === 'connected') void this.probe(c);
      }
    }));
  }

  /** Read the health for one server. Undefined = never probed. */
  get(serverName: string): BackupHealthEntry | undefined {
    return this.health.get(serverName);
  }

  /** Aggregate across the given server set. ok ⇔ every probed server ok. */
  aggregate(serverNames: readonly string[]): {
    overall: BackupHealthStatus;
    failed: { name: string; reason?: string }[];
  } {
    if (serverNames.length === 0) {
      return { overall: 'unchecked', failed: [] };
    }
    const failed: { name: string; reason?: string }[] = [];
    let anyOk = false;
    for (const n of serverNames) {
      const e = this.health.get(n);
      if (!e || e.status === 'unchecked') continue;
      if (e.status === 'failed') failed.push({ name: n, reason: e.reason });
      else if (e.status === 'ok') anyOk = true;
    }
    if (failed.length > 0) return { overall: 'failed', failed };
    if (anyOk) return { overall: 'ok', failed };
    return { overall: 'unchecked', failed };
  }

  private clear(serverName: string): void {
    if (this.health.has(serverName)) {
      this.health.delete(serverName);
      this.emitter.fire(serverName);
    }
  }

  private async probe(conn: SshConnection): Promise<void> {
    const cfg = this.config.config.safety.autoBackup;
    if (!cfg.enabled) {
      // No need to probe when autoBackup is off — clear any stale entry
      // so the UI doesn't keep an old ok/failed around.
      this.clear(conn.server.name);
      return;
    }
    const dir = cfg.backupDir;
    if (!dir || !dir.startsWith('/')) {
      this.setEntry(conn.server.name, 'failed', `invalid backupDir: '${dir}'`);
      return;
    }
    // mkdir -p is idempotent; -w probes operator's write permission. We
    // capture stderr and surface it on failure so the tooltip can tell
    // the operator WHY backup will fail (Permission denied, Read-only fs,
    // disk full, etc.) without them needing to read OutputChannel.
    const dirQ = shellQuote(dir);
    const cmd = `mkdir -p ${dirQ} 2>&1 && [ -w ${dirQ} ] && echo __BAK_OK__`;
    try {
      const r = await runRemoteCommand(conn, cmd, { timeoutMs: 5_000 });
      const ok = r.exitCode === 0 && r.stdout.includes('__BAK_OK__');
      if (ok) {
        this.setEntry(conn.server.name, 'ok');
      } else {
        const reason = (r.stderr || r.stdout || `exit ${r.exitCode}`)
          .replace(/__BAK_OK__/g, '')
          .trim()
          .split('\n')[0]
          ?? 'probe failed';
        this.setEntry(conn.server.name, 'failed', reason);
        log.warn(`backup probe failed on ${conn.server.name}: ${reason}`);
      }
    } catch (err) {
      this.setEntry(conn.server.name, 'failed', (err as Error).message);
      log.warn(`backup probe error on ${conn.server.name}`, err);
    }
  }

  private setEntry(serverName: string, status: BackupHealthStatus, reason?: string): void {
    const cur = this.health.get(serverName);
    if (cur && cur.status === status && cur.reason === reason) return;
    this.health.set(serverName, reason !== undefined ? { status, reason } : { status });
    this.emitter.fire(serverName);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.emitter.dispose();
  }
}
