import * as vscode from 'vscode';
import type { CommandContext } from './context.js';
import { pickServer } from './serverPicker.js';
import { connectWithRetry } from './connect.js';
import { SshPty } from '../ssh/pty.js';

export async function cmdOpenTerminal(ctx: CommandContext, arg: unknown): Promise<void> {
  const server = await pickServer(ctx.config.config, arg, 'Open Terminal for server');
  if (!server) {
    return;
  }

  const existing = ctx.terminals.get(server.name);
  if (existing) {
    existing.show();
    return;
  }

  if (!(await connectWithRetry(ctx, server))) {
    return;
  }
  const conn = ctx.registry.get(server.name);
  if (!conn) {
    return;
  }

  const pty = new SshPty({
    connection: conn,
    safety: ctx.config.config.safety,
    aliases: ctx.config.config.aliases,
    recordHistory: (name, command) => {
      void ctx.history.record(name, command);
    }
  });

  const terminal = vscode.window.createTerminal({
    name: `SSH: ${server.name}`,
    pty,
    iconPath: new vscode.ThemeIcon('terminal-linux')
  });
  ctx.terminals.set(server.name, terminal);

  const closeSub = vscode.window.onDidCloseTerminal(closed => {
    if (closed === terminal) {
      ctx.terminals.delete(server.name);
      // Closing the Terminal just removes the shell channel; the connection
      // stays persistent. SFTP / FSP / mirror / broadcast all remain usable
      // on the same Client. Explicit "Disconnect" on the TreeView (or
      // "Disconnect All") tears the connection down.
      closeSub.dispose();
    }
  });

  terminal.show();
}
