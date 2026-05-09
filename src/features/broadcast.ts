import * as vscode from 'vscode';
import type { ServerConfig, AppConfig } from '../config/types.js';
import { ConnectionRegistry } from '../ssh/connection.js';
import { runRemoteCommand } from '../ssh/runner.js';
import { wrapBackup } from './backup.js';
import { confirmDestCheck } from './destCheck.js';
import { detectModifying } from './safety.js';
import type { OutputManager } from '../output/channel.js';
import type { CommandHistory } from './history.js';
import { log } from '../util/logger.js';

export interface BroadcastOptions {
  servers: readonly ServerConfig[];
  command: string;
  config: AppConfig;
  registry: ConnectionRegistry;
  output: OutputManager;
  history: CommandHistory;
  timeoutMs: number;
}

/**
 * Run a command across many servers in parallel.
 * - Streams per-server output to the OutputChannel with [name] prefix
 * - Honors auto-backup / dest-check if enabled
 * - Records to history under a synthetic "@broadcast" key
 */
export async function broadcastCommand(opts: BroadcastOptions): Promise<void> {
  const { servers, command, config, registry, output, history, timeoutMs } = opts;
  if (servers.length === 0 || !command.trim()) {
    return;
  }

  let toRun = command;
  if (detectModifying(command)) {
    // Pre-flight: stat the destination on each target via SFTP. If the
    // path already exists on ANY target, prompt before overwriting.
    if (config.safety.destCheck.enabled) {
      const proceed = await confirmDestCheck(
        command,
        servers,
        registry,
        config.safety.destCheck,
        config.safety.autoBackup.enabled
          ? `Auto-backup is enabled (backupDir: ${config.safety.autoBackup.backupDir}).`
          : 'Auto-backup is OFF — overwrites are NOT recoverable.'
      );
      if (!proceed) {
        output.line('@broadcast', '(cancelled — destination already exists)');
        return;
      }
    }
    if (config.safety.autoBackup.enabled) {
      toRun = wrapBackup(toRun, config.safety.autoBackup);
    }
  }

  await history.record('@broadcast', command);
  // Don't auto-pop the bottom OutputChannel — the SSH Fleet webview panel is
  // the primary surface; the channel is a backup log the user can open
  // manually if they want it.
  output.header(`▶ Broadcasting to ${servers.length} server(s): ${command}`);

  const results = await Promise.all(servers.map(async server => {
    try {
      const conn = await registry.ensure(server);
      // No "running..." line — silence on the happy path. The streaming
      // stdout / stderr is signal enough that the command is in flight.
      const result = await runRemoteCommand(conn, toRun, {
        timeoutMs,
        onStdout: chunk => output.stream(server.name, chunk, 'stdout'),
        onStderr: chunk => output.stream(server.name, chunk, 'stderr')
      });
      // Only emit a status line on FAILURE (non-zero exit, timeout). A
      // clean exit-0 doesn't need a footer — the user got the output and
      // the run-progress indicator already shows completion counts.
      if (result.exitCode !== 0 || result.timedOut) {
        const note = result.timedOut ? ' (timed out)' : '';
        output.line(server.name, `✗ exit ${result.exitCode}${note} (${(result.durationMs / 1000).toFixed(1)}s)`);
      }
      return { server: server.name, ok: result.exitCode === 0, timedOut: result.timedOut };
    } catch (err) {
      log.error(`Broadcast failed on ${server.name}`, err);
      output.line(server.name, `✗ error: ${(err as Error).message}`);
      return { server: server.name, ok: false, timedOut: false };
    }
  }));

  const ok = results.filter(r => r.ok).length;
  const failed = results.length - ok;
  output.header(`■ Done: ${ok}/${results.length} succeeded${failed ? `, ${failed} failed` : ''}`);

  if (failed > 0) {
    void vscode.window.showWarningMessage(
      `SSH Fleet: ${failed}/${results.length} server(s) failed — see SSH Fleet output`
    );
  }
  // Success path: silent — output panel header already says '■ Done: N/N succeeded'.
}
