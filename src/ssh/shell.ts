import type { ClientChannel } from 'ssh2';
import * as vscode from 'vscode';
import type { SshConnection } from './connection.js';
import { log } from '../util/logger.js';

export interface ShellOptions {
  rows: number;
  cols: number;
  term?: string;
  env?: Record<string, string>;
}

/** Wraps an interactive ssh2 shell Channel with VSCode-friendly events. */
export class SshShell implements vscode.Disposable {
  private channel: ClientChannel | undefined;
  private readonly dataEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  readonly onData = this.dataEmitter.event;
  readonly onClose = this.closeEmitter.event;

  constructor(readonly connection: SshConnection) {}

  async open(opts: ShellOptions): Promise<void> {
    const window = {
      rows: opts.rows,
      cols: opts.cols,
      height: 0,
      width: 0,
      term: opts.term ?? 'xterm-256color'
    };
    const options = opts.env ? { env: opts.env } : {};

    this.channel = await new Promise<ClientChannel>((resolve, reject) => {
      this.connection.client.shell(window, options, (err, ch) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(ch);
      });
    });

    this.channel.on('data', (data: Buffer) => {
      this.dataEmitter.fire(data.toString('utf-8'));
    });
    this.channel.stderr.on('data', (data: Buffer) => {
      this.dataEmitter.fire(data.toString('utf-8'));
    });
    this.channel.on('close', () => {
      this.closeEmitter.fire();
    });
    this.channel.on('error', (err: Error) => {
      log.error(`Shell error on ${this.connection.server.name}`, err);
      // Without this the terminal sits there silently broken — an ANSI-red
      // banner tells the operator the channel is dead and they need to
      // close & reopen the terminal.
      this.dataEmitter.fire(`\r\n\x1b[31mssh-fleet: shell channel error — ${err.message}\x1b[0m\r\n`);
    });
  }

  write(data: string): void {
    this.channel?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.channel?.setWindow(rows, cols, 0, 0);
  }

  dispose(): void {
    this.channel?.end();
    this.channel?.removeAllListeners();
    this.channel = undefined;
    this.dataEmitter.dispose();
    this.closeEmitter.dispose();
  }
}
