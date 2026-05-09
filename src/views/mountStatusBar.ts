import * as vscode from 'vscode';
import { SCHEME as SSH_SCHEME } from './sshFileSystemProvider.js';

/**
 * Permanent left-aligned status bar indicator that names which remote
 * server(s) the current VSCode window has mounted via SSH Fleet. Only
 * renders when at least one workspace folder uses the `ssh-fleet://`
 * scheme — local-only windows show nothing, keeping the status bar
 * uncluttered for users who don't have a mount.
 *
 * Click → opens the SSH Fleet Console (`ssh-fleet.openPanel`) so the
 * operator can run commands against the same servers whose files they're
 * browsing in the explorer.
 *
 * Refresh is event-driven via `onDidChangeWorkspaceFolders`. mount or
 * unmount of any folder fires that event and the text is recomputed —
 * no polling.
 */
export class MountStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subs: vscode.Disposable[] = [];

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = 'ssh-fleet.openPanel';
    this.subs.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh())
    );
    this.refresh();
  }

  private refresh(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const sshFolders = folders.filter(f => f.uri.scheme === SSH_SCHEME);
    if (sshFolders.length === 0) {
      this.item.hide();
      return;
    }
    const servers = [...new Set(sshFolders.map(f => f.uri.authority))];
    const label = servers.length === 1
      ? servers[0]
      : `${servers.length} servers`;
    this.item.text = `$(plug) SSH: ${label}`;
    // Tooltip lists every mounted folder so multi-root cases are
    // self-explanatory without further click.
    this.item.tooltip = sshFolders
      .map(f => `${f.uri.authority}:${f.uri.path || '/'}`)
      .join('\n');
    this.item.show();
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.item.dispose();
  }
}
