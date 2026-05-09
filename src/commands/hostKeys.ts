import * as vscode from 'vscode';
import type { CommandContext } from './context.js';

/**
 * List trusted host keys; let the user forget any of them so the next
 * connection re-prompts (useful after legitimate server-key rotation).
 */
export async function cmdManageKnownHosts(ctx: CommandContext): Promise<void> {
  const list = await ctx.hostKeys.list();
  if (list.length === 0) {
    void vscode.window.showInformationMessage('SSH Fleet: no trusted host keys yet.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    list.map(({ host, entry }) => {
      const { actualHost, port } = parseStoredKey(host);
      return {
        label: host,
        description: `${entry.algorithm}  SHA256:${entry.sha256}`,
        detail: `accepted ${new Date(entry.acceptedAt).toLocaleString()}`,
        actualHost,
        port
      };
    }),
    { title: 'Trusted host keys — pick to forget' }
  );
  if (!pick) {
    return;
  }
  const proceed = await vscode.window.showWarningMessage(
    `Forget host key for ${pick.label}? The next connection will re-prompt for verification.`,
    { modal: true },
    'Forget'
  );
  if (proceed === 'Forget') {
    await ctx.hostKeys.forget(pick.actualHost, pick.port);
    void vscode.window.showInformationMessage(`SSH Fleet: forgot ${pick.label}`);
  }
}

function parseStoredKey(stored: string): { actualHost: string; port: number } {
  // Storage format: `host` for port 22, `[host]:port` otherwise.
  const match = stored.match(/^\[([^\]]+)\]:(\d+)$/);
  if (match) {
    return { actualHost: match[1], port: Number(match[2]) };
  }
  return { actualHost: stored, port: 22 };
}
