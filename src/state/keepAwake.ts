import * as cp from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { log } from '../util/logger.js';

/**
 * Cross-platform "keep the local workstation awake" helper.
 *
 * Holds a subprocess alive for as long as we want sleep prevention.
 * When the subprocess exits (we kill it, or VS Code crashes), the OS
 * automatically releases its sleep-inhibitor lock. That's safer than a
 * persistent flag we could leak — there's no scenario where the lock
 * survives our process dying.
 *
 * Per-platform primitives:
 *   - macOS:    `caffeinate -di`
 *   - Linux:    `systemd-inhibit --what=idle:sleep ...`
 *   - Windows:  `python.exe resources/prevent_sleep.py` (sleep API +
 *               mouse nudge; needs python.exe on PATH)
 *
 * Idempotent: calling `start()` while already running is a no-op;
 * `stop()` while not running is a no-op. The extension uses a
 * latching gate (see `extension.ts`): a one-way trigger starts the
 * inhibitor on the first sign of real SSH Fleet use, and it then runs
 * until the window closes or `settings.preventSleep` flips off.
 */
export class KeepAwake implements vscode.Disposable {
  private proc: cp.ChildProcess | undefined;
  private starting = false;

  constructor(private readonly extensionUri?: vscode.Uri) {}

  isActive(): boolean {
    return this.proc !== undefined;
  }

  start(): void {
    if (this.proc || this.starting) return;
    this.starting = true;
    const platform = os.platform();
    let cmd: string;
    let args: string[];
    if (platform === 'darwin') {
      cmd = 'caffeinate';
      // -d: prevent display sleep; -i: prevent idle sleep (system sleep
      // when no input). Together they cover the operator-walks-away case.
      args = ['-di'];
    } else if (platform === 'linux') {
      // `systemd-inhibit` holds an inhibitor lock for as long as the
      // command it spawns is running. We pass `sleep infinity` as the
      // child so the lock lives for the lifetime of our subprocess.
      cmd = 'systemd-inhibit';
      args = [
        '--what=idle:sleep',
        '--who=SSH Fleet',
        '--why=Active SSH sessions',
        'sleep', 'infinity'
      ];
    } else if (platform === 'win32') {
      if (!this.extensionUri) {
        log.warn('KeepAwake: extensionUri not set, cannot locate prevent_sleep.py');
        this.starting = false;
        return;
      }
      // The script holds the lock via ctypes → `SetThreadExecutionState`
      // for as long as it runs. We kill it via stop() and the OS
      // releases the lock on process exit.
      cmd = 'python.exe';
      const scriptPath = path.join(this.extensionUri.fsPath, 'resources', 'prevent_sleep.py');
      args = [scriptPath];
    } else {
      log.warn(`KeepAwake: unsupported platform ${platform}, skipping`);
      this.starting = false;
      return;
    }
    try {
      const proc = cp.spawn(cmd, args, {
        stdio: 'ignore',
        windowsHide: true,
        // Windows-only: independent session leader so Power Throttling
        // doesn't classify the helper as background and silently no-op
        // its SetThreadExecutionState call.
        detached: platform === 'win32'
      });
      proc.on('error', (err) => {
        log.warn(`KeepAwake: ${cmd} failed to spawn: ${err.message}`);
        if (this.proc === proc) this.proc = undefined;
      });
      proc.on('exit', (code, signal) => {
        if (this.proc === proc) {
          this.proc = undefined;
          log.info(`KeepAwake: helper exited (code=${code} signal=${signal ?? 'none'})`);
        }
      });
      this.proc = proc;
      log.info(`KeepAwake: started (${cmd} pid=${proc.pid})`);
    } catch (err) {
      log.warn(`KeepAwake: spawn failed: ${(err as Error).message}`);
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch {
      // ignore — already exited
    }
    this.proc = undefined;
    log.info('KeepAwake: stopped');
  }

  dispose(): void {
    this.stop();
  }
}
