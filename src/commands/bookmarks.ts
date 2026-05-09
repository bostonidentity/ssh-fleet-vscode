import * as vscode from 'vscode';
import type { CommandContext } from './context.js';

/** Insert a saved path into the focused Terminal. */
export async function cmdInsertBookmark(ctx: CommandContext): Promise<void> {
  const term = vscode.window.activeTerminal;
  if (!term || !term.name.startsWith('SSH: ')) {
    void vscode.window.showWarningMessage('SSH Fleet: focus an SSH terminal first.');
    return;
  }
  const all = ctx.bookmarks.list(ctx.config.config.bookmarks);
  if (all.length === 0) {
    void vscode.window.showInformationMessage('SSH Fleet: no bookmarks. Add one via "Bookmark Path".');
    return;
  }
  const items: (vscode.QuickPickItem & { path?: string; action?: 'add' | 'remove' })[] = [
    { label: '$(add) Add new bookmark…', action: 'add' },
    { label: '$(trash) Remove a bookmark…', action: 'remove' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    ...all.map(p => ({ label: p, path: p }))
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'Bookmarks' });
  if (!pick) {
    return;
  }
  if (pick.action === 'add') {
    const newPath = await vscode.window.showInputBox({
      prompt: 'Path to bookmark',
      placeHolder: '/var/log/'
    });
    if (newPath) {
      await ctx.bookmarks.add(newPath);
    }
    return;
  }
  if (pick.action === 'remove') {
    const userBookmarks = ctx.bookmarks.list(ctx.config.config.bookmarks).filter(p => !ctx.config.config.bookmarks.includes(p));
    if (userBookmarks.length === 0) {
      void vscode.window.showInformationMessage('SSH Fleet: no user-added bookmarks to remove (config-defined ones must be edited in YAML).');
      return;
    }
    const target = await vscode.window.showQuickPick(userBookmarks, { title: 'Remove which bookmark?' });
    if (target) {
      await ctx.bookmarks.remove(target);
    }
    return;
  }
  if (pick.path) {
    term.sendText(pick.path, false);
  }
}
