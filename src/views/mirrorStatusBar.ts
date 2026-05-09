import * as vscode from 'vscode';
import type { MirrorStore } from '../features/mirror.js';
import { log } from '../util/logger.js';

const CTX_KEY = 'ssh-fleet.activeFileIsMirrored';

/**
 * Status-bar item that reflects the mirror state of the active editor.
 * Also maintains the `ssh-fleet.activeFileIsMirrored` context key, which
 * gates the editor/title push/pull buttons (defined in package.json).
 */
export class MirrorStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subs: vscode.Disposable[] = [];
  private lastLoggedKey: string | undefined;

  constructor(private readonly mirror: MirrorStore) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.item.command = 'ssh-fleet.pushToRemote';

    this.subs.push(vscode.window.onDidChangeActiveTextEditor(() => this.refresh()));
    this.subs.push(vscode.workspace.onDidSaveTextDocument(() => this.refresh()));
    this.subs.push(vscode.workspace.onDidChangeTextDocument(e => {
      // Only react to changes in real files. Output channels, debug
      // consoles, etc. have non-file schemes and are never mirror
      // targets — listening to them would create a feedback loop when
      // the active editor IS the SSH Fleet Output channel: refresh()
      // calls log.info → channel content changes → this handler fires
      // → refresh() again. Burned ~4ms per iteration filling the log.
      if (e.document.uri.scheme !== 'file') return;
      if (e.document === vscode.window.activeTextEditor?.document) {
        this.refresh();
      }
    }));
    this.subs.push(mirror.onDidChange(() => this.refresh()));

    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const entry = editor ? this.mirror.forUri(editor.document.uri) : undefined;

    void vscode.commands.executeCommand('setContext', CTX_KEY, !!entry);
    // Log only on transitions — the per-call log was noisy enough that
    // it dominated the output channel during heavy editor switching.
    const key = `${editor ? editor.document.uri.toString() : '(none)'}|${!!entry}`;
    if (key !== this.lastLoggedKey) {
      this.lastLoggedKey = key;
      log.info(`MirrorStatusBar: ${editor ? editor.document.uri.toString() : '(no editor)'} → contextKey=${!!entry}`);
    }

    if (!entry) {
      this.item.hide();
      return;
    }

    const state = await this.mirror.stateFor(entry);
    if (state.status === 'modified') {
      this.item.text = `$(cloud-upload) ${entry.serverName}: ● modified`;
      this.item.tooltip = new vscode.MarkdownString(
        `**Mirror — unpushed changes**\n\n` +
        `\`${entry.serverName}:${entry.remotePath}\`\n\n` +
        `Click to push to remote.`
      );
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.text = `$(cloud) ${entry.serverName}: in sync`;
      this.item.tooltip = new vscode.MarkdownString(
        `**Mirror — in sync**\n\n` +
        `\`${entry.serverName}:${entry.remotePath}\`\n\n` +
        `Last synced ${new Date(entry.downloadedAt).toLocaleString()}.`
      );
      this.item.backgroundColor = undefined;
    }
    this.item.show();
  }

  dispose(): void {
    for (const s of this.subs) {
      s.dispose();
    }
    this.item.dispose();
  }
}
