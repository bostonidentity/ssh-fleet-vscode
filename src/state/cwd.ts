import * as path from 'node:path/posix';
import * as vscode from 'vscode';
import type { ConnectionRegistry, SshConnection } from '../ssh/connection.js';
import { runRemoteCommand } from '../ssh/runner.js';
import { log } from '../util/logger.js';

const HOME_FALLBACK = '~';
/**
 * globalState key for the per-server home directory cache. Storing
 * `Record<serverName, homePath>` lets the panel show absolute paths
 * (`/home/admin`) immediately on next session instead of briefly
 * flashing `~` while we re-probe via SSH. Cleared per-server only on
 * an actual probe finding a new value, NOT on disconnect (the home
 * dir is a server property, not a connection lifecycle property).
 */
const HOME_CACHE_KEY = 'ssh-fleet.cwd.homes.v1';

/**
 * Virtual current-working-directory state, kept locally per server.
 *
 * The ssh2 remote-command channel is stateless — each one-shot run starts a
 * fresh shell, so a literal `cd /opt` doesn't persist between commands. We
 * make it *feel* persistent by (1) intercepting `cd` lines client-side,
 * (2) tracking each server's logical cwd here, (3) prepending `cd <cwd> && `
 * to every other command before dispatching.
 */
export class VirtualCwdState implements vscode.Disposable {
  /** Per-server cwd. Servers we've never asked about default to home (`~`). */
  private readonly cwd = new Map<string, string>();
  /** Per-server previous cwd, used to support `cd -`. */
  private readonly previous = new Map<string, string>();
  /** Per-server actual home dir, learned lazily on first interaction.
   *  Hydrated from `globalState` on construction so absolute paths show
   *  immediately on subsequent sessions; persisted on every probe. */
  private readonly home = new Map<string, string>();

  private readonly emitter = new vscode.EventEmitter<{ servers: string[] }>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly globalState?: vscode.Memento
  ) {
    // Load persisted home cache. Failure here is non-fatal — we'll
    // re-probe on next connect.
    const cached = this.globalState?.get<Record<string, string>>(HOME_CACHE_KEY) ?? {};
    for (const [name, home] of Object.entries(cached)) {
      if (typeof home === 'string' && home.startsWith('/')) {
        this.home.set(name, home);
      }
    }
  }

  private persistHomes(): void {
    if (!this.globalState) return;
    const obj: Record<string, string> = {};
    for (const [name, home] of this.home) obj[name] = home;
    void this.globalState.update(HOME_CACHE_KEY, obj);
  }

  /**
   * Get the current cwd for a server. Fallback chain:
   *   1. live `cwd` (set by applyCd / initFromConnection)
   *   2. cached `home` (in-memory + globalState — survives disconnect)
   *   3. `~` placeholder (literally never been to this server)
   * The `home` fallback is what makes the breadcrumb show the absolute
   * path during the brief window between connect and pwd-probe.
   */
  cwdOf(serverName: string): string {
    return this.cwd.get(serverName) ?? this.home.get(serverName) ?? HOME_FALLBACK;
  }

  /**
   * Returns the common cwd if all of the given servers agree, else undefined
   * (caller renders "~mixed~" or similar).
   */
  commonCwd(serverNames: readonly string[]): string | undefined {
    if (serverNames.length === 0) return undefined;
    const first = this.cwdOf(serverNames[0]);
    for (let i = 1; i < serverNames.length; i++) {
      if (this.cwdOf(serverNames[i]) !== first) return undefined;
    }
    return first;
  }

  /** Per-server breakdown for `:cwd` console listing. */
  breakdown(serverNames: readonly string[]): { name: string; cwd: string }[] {
    return serverNames.map(n => ({ name: n, cwd: this.cwdOf(n) }));
  }

  /**
   * Detect a leading `cd …` and return a plan: the parsed target per server
   * (resolving `cd -`, `cd ~`, relative paths from each server's current cwd),
   * or null if the line isn't a `cd`.
   *
   * Also recognises the `cd <path> && <suffix>` shape so a breadcrumb-style
   * click can navigate AND auto-`ls` in one round-trip — the suffix is
   * returned alongside the cd plan and dispatched after the state update.
   */
  parseCd(serverNames: readonly string[], line: string): null | {
    targets: { name: string; target: string }[];
    suffix?: string;
  } {
    let trimmed = line.trim();
    let suffix: string | undefined;
    // Split on the first ` && ` so `cd /opt && ls -ltrh` separates cleanly.
    // The split keys on whitespace around `&&` to avoid matching paths that
    // contain `&&` literally (extremely rare, but cheap to be safe).
    const splitIdx = trimmed.indexOf(' && ');
    if (splitIdx > 0) {
      const before = trimmed.slice(0, splitIdx).trim();
      // Only peel off the suffix when the prefix is itself a bare cd —
      // otherwise this isn't a navigation, just a regular `&&` chain.
      if (/^cd(?:\s+\S+)?$/.test(before)) {
        suffix = trimmed.slice(splitIdx + 4).trim();
        trimmed = before;
      }
    }
    const m = trimmed.match(/^cd(?:\s+(\S.*))?\s*$/);
    if (!m) return null;
    const arg = (m[1] ?? '').trim();
    const targets: { name: string; target: string }[] = [];
    for (const name of serverNames) {
      const cur = this.cwdOf(name);
      const home = this.home.get(name) ?? HOME_FALLBACK;
      let target: string;
      if (!arg || arg === '~') {
        target = home;
      } else if (arg === '-') {
        target = this.previous.get(name) ?? cur;
      } else if (arg.startsWith('/')) {
        target = path.normalize(arg);
      } else if (arg.startsWith('~/')) {
        target = path.join(home, arg.slice(2));
      } else {
        const base = cur === HOME_FALLBACK ? home : cur;
        target = path.normalize(path.join(base, arg));
      }
      if (target.length > 1 && target.endsWith('/')) {
        target = target.slice(0, -1);
      }
      targets.push({ name, target });
    }
    return suffix ? { targets, suffix } : { targets };
  }

  /**
   * Validate that `cd target` actually works on each server (the directory
   * exists), and update tracked cwd. Reports per-server outcomes.
   */
  async applyCd(targets: { name: string; target: string }[]): Promise<{
    ok: { name: string; target: string }[];
    failed: { name: string; target: string; reason: string }[];
  }> {
    const ok: { name: string; target: string }[] = [];
    const failed: { name: string; target: string; reason: string }[] = [];

    await Promise.all(targets.map(async ({ name, target }) => {
      const conn = this.registry.get(name);
      if (!conn || conn.state !== 'connected') {
        // Record optimistically — supports the "set cwd before connecting"
        // workflow. The unvalidated path will get re-validated by the
        // remote on the first command that prepends `cd <target>`; if it's
        // bogus, the user sees a clear `cd: no such directory` error there.
        this.recordChange(name, target);
        ok.push({ name, target });
        return;
      }
      try {
        const cmd = `cd ${shellQuote(target)} 2>&1 && pwd`;
        const r = await runRemoteCommand(conn, cmd, { timeoutMs: 8_000 });
        if (r.exitCode === 0) {
          const resolved = r.stdout.trim().split('\n').pop()?.trim();
          this.recordChange(name, resolved && resolved.length > 0 ? resolved : target);
          ok.push({ name, target: resolved ?? target });
        } else {
          const reason = (r.stderr || r.stdout || `exit ${r.exitCode}`).trim().split('\n')[0];
          failed.push({ name, target, reason });
        }
      } catch (err) {
        failed.push({ name, target, reason: (err as Error).message });
      }
    }));

    if (ok.length > 0) {
      this.emitter.fire({ servers: ok.map(o => o.name) });
    }
    return { ok, failed };
  }

  private recordChange(name: string, newCwd: string): void {
    const prev = this.cwd.get(name);
    if (prev && prev !== newCwd) {
      this.previous.set(name, prev);
    }
    this.cwd.set(name, newCwd);
  }

  /** Wrap a command with `cd <cwd> && ` (per server). Returns command-by-server. */
  prependFor(serverNames: readonly string[], command: string): { name: string; command: string }[] {
    return serverNames.map(name => {
      const c = this.cwd.get(name);
      if (!c || c === HOME_FALLBACK) {
        return { name, command };
      }
      return { name, command: `cd ${shellQuote(c)} && ${command}` };
    });
  }

  /** Probe a server's home directory once, used when resolving `cd ~`. */
  async ensureHome(conn: SshConnection): Promise<void> {
    if (this.home.has(conn.server.name)) return;
    try {
      const r = await runRemoteCommand(conn, 'echo $HOME', { timeoutMs: 5_000 });
      if (r.exitCode === 0 && r.stdout.trim()) {
        this.home.set(conn.server.name, r.stdout.trim());
        this.persistHomes();
      }
    } catch (err) {
      log.warn(`home probe failed for ${conn.server.name}: ${(err as Error).message}`);
    }
  }

  /**
   * Auto-detect this server's starting directory immediately after connect.
   * Runs `echo $HOME; pwd` in one round-trip; caches both.
   *
   * We DO probe even if a cwd is already cached *as long as* the cached
   * value is the `~` placeholder — that placeholder gets recorded by
   * `applyCd` when the user clicks `cd ~` while the server is still idle,
   * and without this carve-out, the eventual connection would never
   * promote it to the real `/home/<user>` path. A real absolute cwd (e.g.
   * the user navigated to `/opt`) is always preserved.
   */
  async initFromConnection(conn: SshConnection): Promise<void> {
    const name = conn.server.name;
    if (conn.state !== 'connected') return;
    const existing = this.cwd.get(name);
    if (existing && existing !== HOME_FALLBACK) return;
    try {
      const r = await runRemoteCommand(conn, 'echo $HOME; pwd', { timeoutMs: 8_000 });
      if (r.exitCode !== 0) return;
      const lines = r.stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const home = lines[0];
      const pwd = lines[lines.length - 1];
      if (home && home.startsWith('/')) {
        const existing = this.home.get(name);
        if (existing !== home) {
          this.home.set(name, home);
          this.persistHomes();
        }
      }
      if (pwd && pwd.startsWith('/')) {
        const cur = this.cwd.get(name);
        if (!cur || cur === HOME_FALLBACK) {
          this.cwd.set(name, pwd);
          this.emitter.fire({ servers: [name] });
        }
      }
    } catch (err) {
      log.warn(`initial cwd probe failed for ${name}: ${(err as Error).message}`);
    }
  }

  /**
   * Reset connection-state for a server when its SSH session is dropped.
   * Keeps the cached `home` because it's a server property (the home
   * directory of the SSH user on that box) — surviving disconnect lets
   * the breadcrumb show the absolute path immediately on reconnect
   * instead of flashing `~` while we re-probe.
   */
  resetServer(serverName: string): void {
    if (this.cwd.has(serverName) || this.previous.has(serverName)) {
      this.cwd.delete(serverName);
      this.previous.delete(serverName);
      this.emitter.fire({ servers: [serverName] });
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./@:%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
