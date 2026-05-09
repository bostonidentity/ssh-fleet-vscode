import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLogger(ctx: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('SSH Fleet (debug)');
  ctx.subscriptions.push(channel);
}

function ts(): string {
  const d = new Date();
  return d.toISOString().slice(11, 23);
}

export const log = {
  info(msg: string, ...rest: unknown[]): void {
    channel?.appendLine(`[${ts()}] ${msg}${rest.length ? ' ' + JSON.stringify(rest) : ''}`);
  },
  warn(msg: string, ...rest: unknown[]): void {
    channel?.appendLine(`[${ts()}] WARN ${msg}${rest.length ? ' ' + JSON.stringify(rest) : ''}`);
  },
  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err !== undefined ? JSON.stringify(err) : '';
    channel?.appendLine(`[${ts()}] ERROR ${msg}${detail ? '\n' + detail : ''}`);
  }
};
