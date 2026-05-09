import * as vscode from 'vscode';
import { SshShell } from './shell.js';
import type { SshConnection } from './connection.js';
import { detectInteractive, detectModifying } from '../features/safety.js';
import { wrapBackup } from '../features/backup.js';
// (No dest-check in interactive shell — see runWithSafety below.)
import { aliasInitScript } from '../features/aliases.js';
import type { SafetyConfig } from '../config/types.js';
import { log } from '../util/logger.js';

export interface PtyContext {
  connection: SshConnection;
  safety: SafetyConfig;
  aliases: Record<string, string>;
  recordHistory(serverName: string, command: string): void;
}

const NL = '\r\n';

/**
 * VSCode Pseudoterminal that bridges to a persistent ssh2 shell channel.
 *
 * Maintains a small shadow input buffer so we can intercept committed
 * (Enter-terminated) lines for safety checks, alias-resolved suggestions,
 * and command history. Character-level keystrokes (vim, top, raw stdin)
 * pass through transparently — only newline-bounded commands are inspected.
 */
export class SshPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;

  private shell: SshShell | undefined;
  private lineBuffer = '';
  private rawMode = false;
  /** Set in close(); guards against fire-after-dispose when an async
   *  handleCommittedLine is still mid-modal when the user closes the term. */
  private disposed = false;
  /**
   * Set when the local lineBuffer can no longer faithfully mirror the remote
   * readline state — e.g. user pressed Tab to autocomplete or used arrow keys
   * to recall history. We can't reliably parse the resulting completed line
   * by sniffing keystrokes, so on Enter we skip safety inspection and just
   * forward `\r` so the remote runs whatever it actually has.
   */
  private bufferDrifted = false;

  constructor(private readonly ctx: PtyContext) {}

  async open(initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
    const cols = initialDimensions?.columns ?? 80;
    const rows = initialDimensions?.rows ?? 24;
    this.writeEmitter.fire(
      `\x1b[2mssh-fleet: connecting to ${this.ctx.connection.server.name}...\x1b[0m${NL}`
    );

    this.shell = new SshShell(this.ctx.connection);
    this.shell.onData(d => this.writeEmitter.fire(d));
    this.shell.onClose(() => {
      this.writeEmitter.fire(`${NL}\x1b[2mssh-fleet: shell closed\x1b[0m${NL}`);
      this.closeEmitter.fire(0);
    });

    try {
      await this.shell.open({ rows, cols });
      const initScript = aliasInitScript(this.ctx.aliases);
      if (initScript) {
        this.shell.write(initScript + '\n');
      }
    } catch (err) {
      log.error('Shell open failed', err);
      this.writeEmitter.fire(
        `\x1b[31mssh-fleet: failed to open shell — ${(err as Error).message}\x1b[0m${NL}`
      );
      this.closeEmitter.fire(1);
    }
  }

  close(): void {
    this.disposed = true;
    this.shell?.dispose();
    this.shell = undefined;
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.shell?.resize(dimensions.columns, dimensions.rows);
  }

  handleInput(data: string): void {
    if (!this.shell) {
      return;
    }
    if (this.rawMode) {
      this.shell.write(data);
      return;
    }

    // Pass-through model: every character the user types streams to the
    // remote *as it's typed*, and the remote's readline echoes it back via
    // shell.onData. So we only re-emit on Enter — we just commit (`\r`) what
    // is already in the remote's input buffer (or replace it via Ctrl-U +
    // wrapped command) instead of re-sending the whole line.
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === '\r' || ch === '\n') {
        const command = this.lineBuffer.trim();
        this.lineBuffer = '';
        this.handleCommittedLine(command).catch(err => {
          log.error('handleCommittedLine', err);
          // Without an on-screen signal the user just sees a hung terminal.
          if (!this.disposed) {
            this.writeEmitter.fire(
              `${NL}\x1b[31mssh-fleet: command-handler error — ${(err as Error).message}\x1b[0m${NL}`
            );
          }
        });
        continue;
      }
      if (ch === '\x7f' || ch === '\b') {
        if (this.lineBuffer.length > 0) {
          this.lineBuffer = this.lineBuffer.slice(0, -1);
        }
        this.shell.write(ch);
        continue;
      }
      if (ch === '\x03') {
        this.lineBuffer = '';
        this.bufferDrifted = false;
        this.shell.write(ch);
        continue;
      }
      if (ch === '\t') {
        // Tab triggers remote-side completion — whatever appears next on the
        // line is no longer reflected in our lineBuffer.
        this.bufferDrifted = true;
        this.shell.write(ch);
        continue;
      }
      if (ch === '\x1b') {
        // ESC begins a multi-char escape sequence (arrow keys, Home/End, …).
        // Pass the rest of the data buffer through and stop tracking — we
        // don't try to parse variable-length escapes locally.
        this.bufferDrifted = true;
        this.shell.write(data.slice(i));
        return;
      }
      if (ch >= ' ') {
        this.lineBuffer += ch;
        this.shell.write(ch);
      } else {
        // Other control bytes (Ctrl-A/E/W/U/L/etc.) — let readline handle.
        this.bufferDrifted = true;
        this.shell.write(ch);
      }
    }
  }

  private async handleCommittedLine(command: string): Promise<void> {
    if (!this.shell || this.disposed) {
      return;
    }
    const server = this.ctx.connection.server;

    // Tab-completed / history-recalled / Ctrl-U-edited lines aren't reliably
    // reflected in our local buffer, so we skip safety inspection and just
    // commit whatever the remote actually has.
    if (this.bufferDrifted || command.length === 0) {
      this.bufferDrifted = false;
      this.shell.write('\r');
      return;
    }

    this.ctx.recordHistory(server.name, command);

    const interactiveReason = detectInteractive(command);
    if (interactiveReason) {
      log.info(`[${server.name}] interactive command: ${interactiveReason}`);
    }

    if (!detectModifying(command)) {
      // Safe: the remote already has the typed line in its buffer; just commit.
      this.shell.write('\r');
      return;
    }

    // Modifying — confirm before letting the remote run it.
    const warn = warningLabelFor(server.name, server.host, this.ctx.safety);
    const label = warn ? ` (server is tagged "${warn.label}")` : '';
    const proceed = await vscode.window.showWarningMessage(
      `Run modifying command on ${server.name}?${label}`,
      { modal: true, detail: command },
      'Run'
    );

    // The await above could have spanned the user closing the terminal —
    // re-check before touching emitters that might now be disposed.
    if (this.disposed || !this.shell) {
      return;
    }
    if (proceed !== 'Run') {
      // Erase the typed line in the remote's readline buffer so cancelling
      // really cancels — without Ctrl-U the chars stay buffered for the
      // next prompt.
      this.shell.write('\x15');
      this.writeEmitter.fire(`${NL}\x1b[33mssh-fleet: cancelled\x1b[0m${NL}`);
      this.shell.write('\r');
      return;
    }

    // Dest-check is intentionally skipped in interactive shell mode —
    // the user is typing live and a popup mid-typing breaks flow. Auto-
    // backup still wraps because that's a non-interactive transformation.
    let toSend = command;
    if (this.ctx.safety.autoBackup.enabled) {
      toSend = wrapBackup(toSend, this.ctx.safety.autoBackup);
    }

    if (toSend === command) {
      // Confirmed but no transformation — the remote already has the right
      // line; just commit it.
      this.shell.write('\r');
      return;
    }

    // Transformed: kill the typed line and send the wrapped version instead.
    this.shell.write('\x15');
    this.shell.write(toSend + '\r');
  }
}

function warningLabelFor(name: string, host: string, safety: SafetyConfig): { label: string } | undefined {
  for (const p of safety.serverWarnPatterns) {
    if (globMatch(p.pattern, name) || globMatch(p.pattern, host)) {
      return { label: p.label };
    }
  }
  return undefined;
}

function globMatch(pattern: string, value: string): boolean {
  const regex = '^' + pattern
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$';
  return new RegExp(regex).test(value);
}
