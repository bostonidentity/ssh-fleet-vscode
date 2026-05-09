import * as vscode from 'vscode';
import type { CommandContext } from './context.js';
import { pickServer } from './serverPicker.js';
import { buildUri } from '../views/sshFileSystemProvider.js';

const HISTORY_KEY = 'ssh-fleet.remotePathHistory.v1';
const MAX_HISTORY = 20;

async function recallPaths(state: vscode.Memento, serverName: string): Promise<string[]> {
  const all = state.get<Record<string, string[]>>(HISTORY_KEY) ?? {};
  return all[serverName] ?? [];
}

async function rememberPath(state: vscode.Memento, serverName: string, path: string): Promise<void> {
  const all = state.get<Record<string, string[]>>(HISTORY_KEY) ?? {};
  const list = all[serverName] ?? [];
  const updated = [path, ...list.filter(p => p !== path)].slice(0, MAX_HISTORY);
  all[serverName] = updated;
  await state.update(HISTORY_KEY, all);
}

async function promptRemotePath(
  state: vscode.Memento,
  serverName: string,
  prompt: string,
  defaultValue?: string
): Promise<string | undefined> {
  const recent = await recallPaths(state, serverName);
  const placeholder = recent[0] ?? defaultValue ?? '/etc/';

  if (recent.length === 0) {
    return vscode.window.showInputBox({
      prompt: `${prompt} on ${serverName}`,
      placeHolder: placeholder,
      value: defaultValue,
      ignoreFocusOut: true
    });
  }

  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(edit) Type a new path…', kind: 'new' as const },
      { label: '', kind: 'sep' as const, sep: true },
      ...recent.map(p => ({ label: p, kind: 'recent' as const }))
    ].map(item => ({
      label: item.label,
      kind: item.label === '' ? vscode.QuickPickItemKind.Separator : vscode.QuickPickItemKind.Default,
      action: item.kind === 'sep' ? undefined : item.kind,
      path: item.kind === 'recent' ? item.label : undefined
    })),
    { title: `${prompt} on ${serverName}`, ignoreFocusOut: true }
  );
  if (!picked) {
    return undefined;
  }
  if (picked.action === 'recent' && picked.path) {
    return picked.path;
  }
  return vscode.window.showInputBox({
    prompt: `${prompt} on ${serverName}`,
    placeHolder: placeholder,
    value: defaultValue,
    ignoreFocusOut: true
  });
}

/** Pick a server, prompt for an absolute remote path, open as a virtual document. */
export async function cmdOpenRemoteFile(ctx: CommandContext, arg: unknown): Promise<void> {
  const server = await pickServer(ctx.config.config, arg, 'Open remote file from…');
  if (!server) {
    return;
  }
  const remotePath = await promptRemotePath(ctx.extension.globalState, server.name, 'Remote file path');
  if (!remotePath) {
    return;
  }
  const uri = buildUri(server.name, remotePath);
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    await rememberPath(ctx.extension.globalState, server.name, remotePath);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `SSH Fleet: cannot open ${uri.toString()} — ${(err as Error).message}`
    );
  }
}

/** Add a remote directory as a workspace folder, browsable in the file explorer. */
export async function cmdMountRemoteFolder(ctx: CommandContext, arg: unknown): Promise<void> {
  const server = await pickServer(ctx.config.config, arg, 'Mount remote folder from…');
  if (!server) {
    return;
  }
  const remotePath = await promptRemotePath(
    ctx.extension.globalState,
    server.name,
    'Remote folder to mount',
    '/'
  );
  if (!remotePath) {
    return;
  }
  const uri = buildUri(server.name, remotePath);
  // Sanity-check that the directory exists before mounting.
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (!(stat.type & vscode.FileType.Directory)) {
      void vscode.window.showErrorMessage(`SSH Fleet: ${remotePath} is not a directory.`);
      return;
    }
  } catch (err) {
    void vscode.window.showErrorMessage(
      `SSH Fleet: cannot reach ${uri.toString()} — ${(err as Error).message}`
    );
    return;
  }

  // Open in a new window — adding the first workspace folder to the
  // current single-folder/no-folder window forces VSCode to reload the
  // workbench (kills all SSH connections, resets webview state). Same UX
  // pattern Microsoft Remote-SSH uses: remote = its own window, original
  // window keeps all live connections intact.
  await vscode.commands.executeCommand('vscode.openFolder', uri, true);
  await rememberPath(ctx.extension.globalState, server.name, remotePath);
}

/** Allow the TreeView's "Open Terminal" inline-icon to also offer file ops. */
export async function cmdBrowseRemote(ctx: CommandContext, arg: unknown): Promise<void> {
  const server = await pickServer(ctx.config.config, arg, 'Browse files on…');
  if (!server) {
    return;
  }
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(file) Open file…', action: 'file' as const },
      { label: '$(folder-opened) Mount folder as workspace…', action: 'folder' as const }
    ],
    { title: `Files on ${server.name}` }
  );
  if (!choice) {
    return;
  }
  if (choice.action === 'file') {
    await cmdOpenRemoteFile(ctx, { serverName: server.name });
  } else {
    await cmdMountRemoteFolder(ctx, { serverName: server.name });
  }
}
