import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ServerConfig, AppConfig, TaskConfig } from '../config/types.js';
import type { ConnectionRegistry } from '../ssh/connection.js';
import { runRemoteCommand } from '../ssh/runner.js';
import { wrapBackup, buildSftpBackupCommand } from './backup.js';
import { confirmDestCheck, confirmDestOverwrite } from './destCheck.js';
import { detectModifying } from './safety.js';
import type { OutputManager } from '../output/channel.js';
import type { CommandHistory } from './history.js';
import { log } from '../util/logger.js';

export interface RunTaskOptions {
  task: TaskConfig;
  servers: readonly ServerConfig[];
  config: AppConfig;
  registry: ConnectionRegistry;
  output: OutputManager;
  history: CommandHistory;
  defaultTimeoutMs: number;
  /**
   * Root of the ssh-fleet workspace (the dir containing `config/` and
   * `tasks/`). Relative `task.src` paths are resolved against this so that
   * `./payloads/foo.sh` always means "inside the operator's workspace,"
   * not "wherever VSCode happens to think CWD is."
   */
  workspaceRoot?: string;
}

function expandHome(p: string): string {
  // `~` and `~/` both expand to the current user's home dir on every
  // platform (`os.homedir()` returns `C:\Users\<name>` on Windows,
  // `/home/<name>` on Linux, `/Users/<name>` on macOS).
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Resolve `task.src` to an absolute local path.
 *
 * Cross-platform notes:
 * - Forward slashes work on Windows (Node's `path` module accepts them).
 * - Absolute paths flow through unchanged: POSIX `/etc/foo`, Windows
 *   drive paths `C:\payloads\foo.sh`, and UNC paths `\\share\foo` all
 *   round-trip via `path.isAbsolute` correctly on the host platform.
 * - `~` expands via `expandHome` on all platforms.
 * - Relative paths anchor at the ssh-fleet workspace root (the dir holding
 *   `config/` + `tasks/`), NOT at whatever VSCode's CWD happens to be.
 *
 * YAML caveat for Windows users: backslashes inside a *double-quoted*
 * scalar are interpreted as escape sequences (`"C:\foo"` becomes a
 * literal C-form-feed-oo). Use plain scalars or single quotes:
 *   src: C:\payloads\app.conf      # plain — fine
 *   src: 'C:\payloads\app.conf'    # single-quoted — fine
 *   src: ./payloads/app.conf       # relative + forward slashes — fine
 *   src: "C:\\payloads\\app.conf"  # double-quoted needs backslash escape
 */
function resolveLocalPath(src: string, workspaceRoot: string | undefined): string {
  const expanded = expandHome(src);
  if (path.isAbsolute(expanded)) return expanded;
  if (!workspaceRoot) return path.resolve(expanded);
  return path.resolve(workspaceRoot, expanded);
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./@:%+=,-]+$/.test(s)) {
    return s;
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function modeOctal(mode: string | undefined): string | undefined {
  if (!mode) {
    return undefined;
  }
  const trimmed = mode.trim();
  // accept "0755", "755", or decimal
  if (/^0?[0-7]{3,4}$/.test(trimmed)) {
    return trimmed.startsWith('0') ? trimmed : '0' + trimmed;
  }
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && asNum >= 0 && asNum <= 0o7777) {
    return '0' + asNum.toString(8);
  }
  return undefined;
}

interface PerServerResult {
  server: string;
  ok: boolean;
  detail: string;
}

/**
 * Run a single task across many servers in parallel. Dispatches by task.type:
 * - command: shell command via remote-exec channel (with optional auto-backup wrap)
 * - upload:  SFTP write + optional chmod
 * - script:  SFTP write to /tmp + chmod 0755 + exec + cleanup
 */
export async function runTaskOnServers(opts: RunTaskOptions): Promise<void> {
  const { task, servers, output, history, defaultTimeoutMs, config, registry } = opts;
  if (servers.length === 0) {
    return;
  }

  const taskTimeoutMs = task.timeout > 0 ? task.timeout * 1000 : defaultTimeoutMs;
  const summary = describeTask(task);

  // Pre-flight dest-check (once, scanning all target servers in parallel)
  // — fires for shell commands AND for `upload` tasks (where the dest is
  // task.dest itself). Asking N times for N servers is bad UX, so we
  // hoist the check up here ahead of the fan-out.
  if (config.safety.destCheck.enabled) {
    const hint = config.safety.autoBackup.enabled
      ? `Auto-backup is enabled (backupDir: ${config.safety.autoBackup.backupDir}).`
      : 'Auto-backup is OFF — overwrites are NOT recoverable.';

    let proceed = true;
    if (task.type === 'command' && task.command && detectModifying(task.command)) {
      // Shell-command task: extractDestPath parses the verb.
      proceed = await confirmDestCheck(
        task.command, servers, registry, config.safety.destCheck, hint
      );
    } else if (
      task.type === 'upload' &&
      task.dest &&
      config.safety.destCheck.commands.includes('upload')
    ) {
      // Upload task: dest is the path itself, no extraction needed —
      // confirmDestOverwrite stats the path directly per-server.
      const dest = task.dest.replace(/\/+$/, '') || '/';
      proceed = await confirmDestOverwrite(dest, servers, registry, hint);
    }
    if (!proceed) {
      output.header(`■ ${summary} — cancelled (destination already exists)`);
      return;
    }
  }

  // No `output.show()` — the SSH Fleet panel is the primary UI; the bottom
  // OutputChannel stays a quiet backup log.
  // Header always names the task by what it actually DOES, never by its
  // (often auto-generated) `name:` field. The command body / src is the
  // meaningful identifier; the symbolic name is only useful for selection
  // in the tree.
  output.header(`▶ Running task on ${servers.length} server(s): ${summary}`);
  await history.record('@broadcast', `task:${task.name}`);

  const results: PerServerResult[] = await Promise.all(
    servers.map(server => runTaskOnSingleServer(server, opts, taskTimeoutMs))
  );

  const ok = results.filter(r => r.ok).length;
  const failed = results.length - ok;
  const failedNames = results.filter(r => !r.ok).map(r => r.server);
  const failedTag = failed
    ? `, ${failed} failed (${failedNames.slice(0, 3).join(', ')}${failedNames.length > 3 ? ` +${failedNames.length - 3} more` : ''})`
    : '';
  output.header(`■ ${summary} — done: ${ok}/${results.length} succeeded${failedTag}`);

  if (failed > 0) {
    void vscode.window.showWarningMessage(
      `SSH Fleet: task '${task.name}' — ${failed}/${results.length} server(s) failed: ${failedNames.slice(0, 3).join(', ')}${failedNames.length > 3 ? ' +more' : ''}`
    );
  }
  // Success path: silent — output panel header already announces '■ Task done: N/N succeeded'.
}

function describeTask(t: TaskConfig): string {
  switch (t.type) {
    case 'command': return t.command ?? '<missing command>';
    case 'upload': return `${t.src} -> ${t.dest}`;
    case 'script': return `script ${t.src}${t.args ? ' ' + t.args : ''}`;
  }
}

async function runTaskOnSingleServer(
  server: ServerConfig,
  opts: RunTaskOptions,
  timeoutMs: number
): Promise<PerServerResult> {
  const { task, config, registry, output } = opts;
  try {
    const conn = await registry.ensure(server);
    // Silent happy path — no "running…" line. Streaming stdout / stderr
    // and the per-run progress widget are sufficient progress signal.

    if (task.type === 'command') {
      let cmd = task.command ?? '';
      // Dest-check already happened up in runTaskOnServers — only the
      // auto-backup wrap is per-server here (it injects per-server
      // timestamped backup paths).
      if (detectModifying(cmd) && config.safety.autoBackup.enabled) {
        cmd = wrapBackup(cmd, config.safety.autoBackup);
      }
      const result = await runRemoteCommand(conn, cmd, {
        timeoutMs,
        ...(task.env ? { env: task.env } : {}),
        onStdout: chunk => output.stream(server.name, chunk, 'stdout'),
        onStderr: chunk => output.stream(server.name, chunk, 'stderr')
      });
      // Only surface a footer on failure — clean exits stay silent.
      if (result.exitCode !== 0 || result.timedOut) {
        const note = result.timedOut ? ' (timed out)' : '';
        output.line(server.name, `✗ exit ${result.exitCode}${note} (${(result.durationMs / 1000).toFixed(1)}s)`);
      }
      return { server: server.name, ok: result.exitCode === 0, detail: `exit ${result.exitCode}` };
    }

    if (task.type === 'upload') {
      const localPath = resolveLocalPath(task.src!, opts.workspaceRoot);
      const data = await fs.readFile(localPath);
      // Auto-backup the EXISTING remote file (if any) before clobbering.
      // SFTP writeFile bypasses the shell, so wrapBackup doesn't fire on
      // its own — buildSftpBackupCommand emits an `if [ -e ] ; cp -a` shell
      // command we run via runRemoteCommand. Returns null when the
      // operator's config has autoBackup off OR 'upload' missing from
      // commands, in which case we skip straight to write.
      const backupCmd = buildSftpBackupCommand(task.dest!, config.safety.autoBackup);
      if (backupCmd) {
        const r = await runRemoteCommand(conn, backupCmd, { timeoutMs: 30_000 });
        if (r.exitCode !== 0) {
          // Don't proceed if backup was supposed to happen but failed —
          // matches the abort-on-backup-failure rule for shell commands.
          throw new Error(`auto-backup failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`}`);
        }
      }
      // Auto-create missing parent dirs on the remote so a fresh dest
      // path like `/tmp/ssh-fleet-demo/file` doesn't fail with "No such
      // file" just because the directory hasn't been pre-created.
      const destDir = path.posix.dirname(task.dest!);
      if (destDir && destDir !== '.' && destDir !== '/') {
        await conn.sftp.mkdirP(destDir);
      }
      await conn.sftp.writeFile(task.dest!, data);
      const mode = modeOctal(task.mode);
      if (mode) {
        const chmodCmd = `chmod ${mode} ${shellQuote(task.dest!)}`;
        await runRemoteCommand(conn, chmodCmd, { timeoutMs: 10_000 });
      }
      const sizeKb = (data.byteLength / 1024).toFixed(1);
      output.line(server.name, `✓ uploaded ${task.src} -> ${task.dest} (${sizeKb} KB${mode ? ', mode ' + mode : ''})`);
      return { server: server.name, ok: true, detail: 'uploaded' };
    }

    if (task.type === 'script') {
      const localPath = resolveLocalPath(task.src!, opts.workspaceRoot);
      const baseName = path.basename(localPath);
      const remoteTmp = `/tmp/_ssh-fleet_${Date.now()}_${baseName}`;
      const data = await fs.readFile(localPath);
      await conn.sftp.writeFile(remoteTmp, data);
      try {
        await runRemoteCommand(conn, `chmod 0755 ${shellQuote(remoteTmp)}`, { timeoutMs: 10_000 });
        const argsPart = task.args ? ' ' + task.args : '';
        const cmd = shellQuote(remoteTmp) + argsPart;
        const result = await runRemoteCommand(conn, cmd, {
          timeoutMs,
          ...(task.env ? { env: task.env } : {}),
          onStdout: chunk => output.stream(server.name, chunk, 'stdout'),
          onStderr: chunk => output.stream(server.name, chunk, 'stderr')
        });
        // Only surface a footer on failure — clean exits stay silent.
        if (result.exitCode !== 0 || result.timedOut) {
          const note = result.timedOut ? ' (timed out)' : '';
          output.line(server.name, `✗ script exit ${result.exitCode}${note} (${(result.durationMs / 1000).toFixed(1)}s)`);
        }
        return { server: server.name, ok: result.exitCode === 0, detail: `exit ${result.exitCode}` };
      } finally {
        // Best-effort cleanup; don't fail the task if rm fails.
        try {
          await runRemoteCommand(conn, `rm -f ${shellQuote(remoteTmp)}`, { timeoutMs: 10_000 });
        } catch (err) {
          log.warn(`Failed to remove ${remoteTmp} on ${server.name}: ${(err as Error).message}`);
        }
      }
    }

    return { server: server.name, ok: false, detail: `unknown task type ${task.type}` };
  } catch (err) {
    log.error(`Task '${task.name}' failed on ${server.name}`, err);
    output.line(server.name, `✗ error: ${(err as Error).message}`);
    return { server: server.name, ok: false, detail: (err as Error).message };
  }
}
