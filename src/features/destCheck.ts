import * as vscode from 'vscode';
import type { DestCheckConfig } from '../config/types.js';
import type { ServerConfig } from '../config/types.js';
import type { ConnectionRegistry } from '../ssh/connection.js';
import { classifySftpError } from '../ssh/sftp.js';

/**
 * Extract the destination path from a command, if the command matches one
 * of the dest-check-eligible verbs (cp / mv / `>` redirect / tee /
 * install). Returns undefined when the command doesn't match, has no
 * inferrable target, or the target is a sentinel like `/dev/null`.
 *
 * Only ABSOLUTE destinations are returned — relative paths require the
 * server's cwd to resolve, which we don't have at extraction time.
 */
export function extractDestPath(command: string, cfg: DestCheckConfig): string | undefined {
  if (!cfg.enabled || !command.trim()) return undefined;

  const trimmed = command.trim();
  // Strip an optional `sudo ` prefix so `sudo cp foo /etc/bar` still
  // matches the cp verb.
  const sudoMatch = trimmed.match(/^(sudo\s+(?:-\S+\s+)*)?(.*)$/);
  const work = sudoMatch?.[2] ?? trimmed;
  const parts = work.split(/\s+/);
  const base = parts[0];
  if (!base) return undefined;

  let target: string | undefined;

  if (cfg.commands.includes(base)) {
    if (base === 'cp' || base === 'mv' || base === 'install') {
      const nonFlag = parts.slice(1).filter(p => !p.startsWith('-'));
      if (nonFlag.length >= 2) {
        const dst = nonFlag[nonFlag.length - 1];
        if (dst.endsWith('/')) {
          // Trailing `/` means dst is a directory container; the actual
          // destination is `dst/<basename(src)>`. Only meaningful when
          // there's exactly one source — multi-source `cp a b c dir/`
          // implies dir must already exist, so dest-check would fire
          // misleadingly. Skip the check in the multi-source case.
          if (nonFlag.length === 2) {
            const src = nonFlag[0];
            const baseName = src.split('/').pop() ?? src;
            target = dst.replace(/\/+$/, '') + '/' + baseName;
          }
          // else: multi-source into a dir — skip the check (target stays undefined)
        } else {
          target = dst;
        }
      }
    } else if (base === 'tee') {
      // `tee [-a] FILE`. -a is append (safe); without -a tee overwrites.
      const flags = parts.slice(1).filter(p => p.startsWith('-')).join(' ');
      if (!/[-]a\b|--append/.test(flags)) {
        const nonFlag = parts.slice(1).filter(p => !p.startsWith('-'));
        target = nonFlag[0];
      }
    }
  }

  // `>` redirect, anywhere in the line. Matches `>` not preceded by `&` or
  // a digit (those are 2>foo / &>foo redirects, still overwrite but the
  // shell-redirection target is the same — keep it simple and match all).
  // `>>` is correctly excluded because the regex requires whitespace or
  // end-of-string after the `>`.
  if (!target && cfg.commands.includes('>')) {
    const m = command.match(/(?<![0-9&>])>\s+(\S+)/);
    if (m) target = m[1];
  }

  if (!target) return undefined;
  if (target === '/dev/null') return undefined;
  if (!target.startsWith('/')) return undefined; // relative — skip
  // Strip a trailing `/` so directory-style paths stat correctly.
  return target.replace(/\/+$/, '') || '/';
}

/**
 * Probe the dest path on each connected target server. Returns the list
 * of servers where the path EXISTS — the caller decides what to do
 * (typically: show a modal asking "overwrite?").
 *
 * Connection failures count as "doesn't exist" for the purposes of the
 * prompt — we don't want a flaky stat to block the run; if the path
 * really exists the actual command will still hit it.
 */
export async function findExistingDestServers(
  servers: readonly ServerConfig[],
  dest: string,
  registry: ConnectionRegistry
): Promise<string[]> {
  const checks = await Promise.all(servers.map(async s => {
    const conn = registry.get(s.name);
    if (!conn || conn.state !== 'connected') return null; // can't stat — skip
    try {
      await conn.sftp.stat(dest);
      return s.name;
    } catch (err) {
      // Permission-denied means the path *does* exist — we just can't read
      // its attrs. Treating that as "missing" would let the actual command
      // run without a confirmation, then clobber. ENOENT and other shapes
      // remain best-effort "missing" so a flaky stat doesn't block the run.
      if (classifySftpError(err) === 'eacces') return s.name;
      return null;
    }
  }));
  return checks.filter((n): n is string => !!n);
}

/**
 * Show a modal asking the operator to confirm an overwrite. Returns true
 * when the user clicks Overwrite, false otherwise (no servers had the
 * dest, OR they cancelled). `autoBackupHint` is appended to the detail
 * block to show whether the run will be wrapped by auto-backup.
 */
export async function confirmDestOverwrite(
  dest: string,
  servers: readonly ServerConfig[],
  registry: ConnectionRegistry,
  autoBackupHint?: string
): Promise<boolean> {
  const existing = await findExistingDestServers(servers, dest, registry);
  if (existing.length === 0) return true;
  const summary =
    existing.length === servers.length
      ? `${dest} already exists on all ${servers.length} target server(s).`
      : `${dest} already exists on ${existing.length} of ${servers.length} server(s):\n  ${existing.join(', ')}`;
  const detail = autoBackupHint ? `${summary}\n\n${autoBackupHint}` : summary;
  const choice = await vscode.window.showWarningMessage(
    'Destination already exists. Overwrite?',
    { modal: true, detail },
    'Overwrite'
  );
  return choice === 'Overwrite';
}

/**
 * Convenience wrapper: extract dest from a shell command, then run the
 * confirmation modal. Used by the broadcast / ad-hoc paths where the
 * command IS the source of truth for the destination.
 */
export async function confirmDestCheck(
  command: string,
  servers: readonly ServerConfig[],
  registry: ConnectionRegistry,
  cfg: DestCheckConfig,
  autoBackupHint?: string
): Promise<boolean> {
  const dest = extractDestPath(command, cfg);
  if (!dest) return true;
  return confirmDestOverwrite(dest, servers, registry, autoBackupHint);
}
