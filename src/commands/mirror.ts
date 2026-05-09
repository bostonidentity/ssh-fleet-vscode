import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommandContext } from './context.js';
import { pickServer, pickServers } from './serverPicker.js';
import { buildUri } from '../views/sshFileSystemProvider.js';
import type { MirrorEntry } from '../features/mirror.js';
import { log as logger } from '../util/logger.js';

/** Pick a server, prompt for an absolute remote path, download to mirror, open locally. */
export async function cmdDownloadRemoteFile(ctx: CommandContext, arg: unknown): Promise<void> {
  // Allow invocation from explorer/context on a ssh-fleet:// URI: use that directly.
  const uriArg = arg instanceof vscode.Uri ? arg : undefined;
  let serverName: string;
  let remotePath: string;
  if (uriArg && uriArg.scheme === 'ssh-fleet') {
    serverName = uriArg.authority;
    remotePath = uriArg.path;
  } else {
    const server = await pickServer(ctx.config.config, arg, 'Download remote file from…');
    if (!server) {
      return;
    }
    serverName = server.name;
    const entered = await vscode.window.showInputBox({
      prompt: `Remote file path on ${serverName}`,
      placeHolder: '/etc/nginx/nginx.conf',
      ignoreFocusOut: true
    });
    if (!entered) {
      return;
    }
    remotePath = entered;
  }

  let entry: MirrorEntry;
  try {
    entry = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading ${remotePath} from ${serverName}…` },
      () => ctx.mirror.download(serverName, remotePath)
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`SSH Fleet: download failed — ${(err as Error).message}`);
    return;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.localPath));
  await vscode.window.showTextDocument(doc);
}

/** Push the active editor's file to remote, with mtime conflict detection. */
export async function cmdPushToRemote(ctx: CommandContext, arg?: unknown): Promise<void> {
  const entry = await resolveEntry(ctx, arg);
  if (!entry) {
    return;
  }

  // Save the editor first so what we push is what the user sees.
  const editor = vscode.window.visibleTextEditors.find(
    e => e.document.uri.fsPath === entry.localPath
  );
  if (editor && editor.document.isDirty) {
    await editor.document.save();
  }

  const state = await ctx.mirror.stateFor(entry);
  if (state.status === 'untracked') {
    void vscode.window.showErrorMessage('SSH Fleet: local copy is missing — was it deleted?');
    return;
  }
  if (state.status === 'clean') {
    const proceed = await vscode.window.showInformationMessage(
      'No local changes since last sync — push anyway?',
      'Push', 'Cancel'
    );
    if (proceed !== 'Push') {
      return;
    }
  }

  // Conflict detection: did the remote change since we downloaded?
  let conflict = false;
  let conflictUnknown = false;
  try {
    const stat = await ctx.mirror.statRemote(entry);
    conflict = stat.mtime > entry.remoteMtimeAtDownload || stat.size !== entry.remoteSizeAtDownload;
  } catch (err) {
    log(`stat remote failed: ${(err as Error).message}`);
    conflictUnknown = true;
  }
  if (conflictUnknown) {
    const proceed = await vscode.window.showWarningMessage(
      `Couldn't check whether the remote changed since download — push could clobber a newer version.`,
      { modal: true, detail: `${entry.serverName}:${entry.remotePath}` },
      'Push Anyway'
    );
    if (proceed !== 'Push Anyway') {
      return;
    }
  }

  if (conflict) {
    const choice = await vscode.window.showWarningMessage(
      `Remote ${entry.serverName}:${entry.remotePath} was modified since you downloaded it.`,
      { modal: true },
      'Show Diff', 'Push Anyway'
    );
    if (!choice) {
      return;
    }
    if (choice === 'Show Diff') {
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(entry.localPath),
        buildUri(entry.serverName, entry.remotePath),
        `Local ↔ Remote: ${entry.serverName}:${entry.remotePath}`
      );
      return;
    }
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Pushing to ${entry.serverName}:${entry.remotePath}…` },
      () => ctx.mirror.push(entry)
    );
    void vscode.window.showInformationMessage(`SSH Fleet: pushed to ${entry.serverName}:${entry.remotePath}`);
  } catch (err) {
    // Show server + path + raw cause so the user can see *why* the SFTP
    // write was rejected. Offer Show Diff as the only follow-up — sudo
    // escalation isn't useful in environments without sudo access.
    const msg = (err as Error).message ?? String(err);
    const detail = `${entry.serverName}:${entry.remotePath}\n\n${msg}`;
    const choice = await vscode.window.showErrorMessage(
      'SSH Fleet: push failed', { modal: true, detail }, 'Show Diff'
    );
    if (choice === 'Show Diff') {
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(entry.localPath),
        buildUri(entry.serverName, entry.remotePath),
        `Local ↔ Remote: ${entry.serverName}:${entry.remotePath}`
      );
    }
  }
}

/** Pull the remote version into the local mirror, overwriting local edits. */
export async function cmdPullFromRemote(ctx: CommandContext, arg?: unknown): Promise<void> {
  const entry = await resolveEntry(ctx, arg);
  if (!entry) {
    return;
  }

  const state = await ctx.mirror.stateFor(entry);
  if (state.status === 'modified') {
    const choice = await vscode.window.showWarningMessage(
      'Local copy has unpushed changes. Pulling will overwrite them.',
      { modal: true },
      'Show Diff', 'Pull Anyway'
    );
    if (!choice) {
      return;
    }
    if (choice === 'Show Diff') {
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(entry.localPath),
        buildUri(entry.serverName, entry.remotePath),
        `Local ↔ Remote: ${entry.serverName}:${entry.remotePath}`
      );
      return;
    }
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Pulling ${entry.serverName}:${entry.remotePath}…` },
      () => ctx.mirror.download(entry.serverName, entry.remotePath)
    );
    void vscode.window.showInformationMessage(`SSH Fleet: pulled ${entry.serverName}:${entry.remotePath}`);
  } catch (err) {
    void vscode.window.showErrorMessage(`SSH Fleet: pull failed — ${(err as Error).message}`);
  }
}

/** Remove the file from the mirror manifest (does not delete the local file). */
export async function cmdUntrackMirror(ctx: CommandContext, arg?: unknown): Promise<void> {
  const entry = await resolveEntry(ctx, arg);
  if (!entry) {
    return;
  }
  await ctx.mirror.untrack(entry.localPath);
  void vscode.window.showInformationMessage(`SSH Fleet: stopped tracking ${entry.localPath}`);
}

/** Open a quick-pick of all mirrored files; selecting one reveals it in the editor. */
export async function cmdShowMirroredFiles(ctx: CommandContext): Promise<void> {
  const entries = ctx.mirror.list();
  if (entries.length === 0) {
    void vscode.window.showInformationMessage('SSH Fleet: no mirrored files yet.');
    return;
  }
  const items = await Promise.all(entries.map(async e => {
    const state = await ctx.mirror.stateFor(e);
    const dirty = state.status === 'modified' ? '● ' : '';
    return {
      label: `${dirty}${e.serverName}: ${e.remotePath}`,
      description: e.localPath,
      detail: `downloaded ${new Date(e.downloadedAt).toLocaleString()}`,
      entry: e
    };
  }));
  const pick = await vscode.window.showQuickPick(items, { title: 'Mirrored files', matchOnDescription: true });
  if (!pick) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(pick.entry.localPath));
  await vscode.window.showTextDocument(doc);
}

/** Reveal the mirror folder in the OS file manager. */
export async function cmdRevealMirrorFolder(ctx: CommandContext): Promise<void> {
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(ctx.mirror.rootPath));
}

async function resolveEntry(ctx: CommandContext, arg: unknown): Promise<MirrorEntry | undefined> {
  // Argument from editor/title menu is the resource Uri of the active editor.
  // forUri auto-tracks path-convention matches when the manifest doesn't
  // yet have an entry (handles fresh-install scenarios where the file
  // synced over from another machine without its manifest record).
  if (arg instanceof vscode.Uri && arg.scheme === 'file') {
    const e = ctx.mirror.forUri(arg);
    if (e) {
      return e;
    }
  }
  // Fall back to the active editor.
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const e = ctx.mirror.forUri(editor.document.uri);
    if (e) {
      return e;
    }
  }
  // Last resort: pick from manifest.
  const entries = ctx.mirror.list();
  if (entries.length === 0) {
    void vscode.window.showInformationMessage('SSH Fleet: no mirrored files. Use "Download Remote File…" first.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    entries.map(e => ({ label: `${e.serverName}: ${e.remotePath}`, description: e.localPath, entry: e })),
    { title: 'Pick a mirrored file' }
  );
  return pick?.entry;
}

function log(msg: string): void {
  // Conflict-detection stat failures used to be silently dropped, which let
  // a "remote unchanged" assumption sneak through and clobber freshly-edited
  // remote files. Route to the real logger so they're at least visible in
  // the OutputChannel; the user-facing path still proceeds.
  logger.warn(`mirror: ${msg}`);
}

/**
 * Upload a local file to a remote directory.
 * - If invoked with no arg: open a file picker.
 * - If invoked with a Uri (file:// from explorer right-click): use that file directly.
 * - Tracks the upload in the mirror manifest, so subsequent push/pull/diff work.
 */
export async function cmdUploadLocalFile(ctx: CommandContext, arg?: unknown): Promise<void> {
  let localUri: vscode.Uri | undefined;
  if (arg instanceof vscode.Uri && arg.scheme === 'file') {
    localUri = arg;
  } else {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Upload',
      title: 'Pick a local file to upload'
    });
    if (!picked || picked.length === 0) {
      return;
    }
    localUri = picked[0];
  }

  const server = await pickServer(ctx.config.config, undefined, 'Upload to which server?');
  if (!server) {
    return;
  }

  const baseName = localUri.path.split('/').pop() ?? 'upload';
  const remotePath = await vscode.window.showInputBox({
    prompt: `Remote destination path on ${server.name}`,
    value: `/tmp/${baseName}`,
    valueSelection: [5, 5 + baseName.length], // pre-select the basename for quick rename
    ignoreFocusOut: true
  });
  if (!remotePath) {
    return;
  }

  // If the remote path already has a matching tracked entry, treat as overwrite confirmation.
  // forUri also surfaces path-convention auto-tracked entries.
  const existingByLocal = ctx.mirror.forUri(localUri);
  if (existingByLocal && (existingByLocal.serverName !== server.name || existingByLocal.remotePath !== remotePath)) {
    const proceed = await vscode.window.showWarningMessage(
      `${localUri.fsPath} is already tracked as ${existingByLocal.serverName}:${existingByLocal.remotePath}. ` +
        `Re-tracking will replace that mapping.`,
      { modal: true },
      'Replace mapping'
    );
    if (proceed !== 'Replace mapping') {
      return;
    }
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Uploading ${baseName} to ${server.name}…` },
      () => ctx.mirror.upload(localUri!.fsPath, server.name, remotePath)
    );
    const action = await vscode.window.showInformationMessage(
      `SSH Fleet: uploaded to ${server.name}:${remotePath}`,
      'Open Local'
    );
    if (action === 'Open Local') {
      const doc = await vscode.workspace.openTextDocument(localUri);
      await vscode.window.showTextDocument(doc);
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`SSH Fleet: upload failed — ${(err as Error).message}`);
  }
}

/**
 * Push the same local file to many servers at once. Streams per-server status
 * to the SSH Fleet OutputChannel; first upload also lands as a tracked mirror
 * entry pointing at the user's local path.
 */
export async function cmdUploadToManyServers(ctx: CommandContext, arg?: unknown): Promise<void> {
  let localUri: vscode.Uri | undefined;
  if (arg instanceof vscode.Uri && arg.scheme === 'file') {
    localUri = arg;
  } else {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Upload',
      title: 'Pick a local file to broadcast'
    });
    if (!picked || picked.length === 0) {
      return;
    }
    localUri = picked[0];
  }

  const servers = await pickServers(ctx.config.config, 'Upload to which servers?');
  if (servers.length === 0) {
    return;
  }
  const baseName = localUri.path.split('/').pop() ?? 'upload';
  const remotePath = await vscode.window.showInputBox({
    prompt: `Remote destination path (same on every server)`,
    value: `/tmp/${baseName}`,
    valueSelection: [5, 5 + baseName.length],
    ignoreFocusOut: true
  });
  if (!remotePath) {
    return;
  }

  const out = ctx.output;
  out.show();
  out.header(`▶ Uploading ${localUri.fsPath} to ${servers.length} server(s) → ${remotePath}`);

  const results = await Promise.all(servers.map(async (server, idx) => {
    try {
      // Track only the first server's upload in the manifest (mirror is 1:1
      // local↔remote; multi-server broadcasts don't fit that model).
      if (idx === 0) {
        await ctx.mirror.upload(localUri!.fsPath, server.name, remotePath);
      } else {
        const data = await fs.readFile(localUri!.fsPath);
        const conn = await ctx.registry.ensure(server);
        await conn.sftp.writeFile(remotePath, data);
      }
      out.line(server.name, `✓ uploaded → ${remotePath}`);
      return { ok: true, name: server.name };
    } catch (err) {
      out.line(server.name, `✗ ${(err as Error).message}`);
      return { ok: false, name: server.name };
    }
  }));

  const ok = results.filter(r => r.ok).length;
  const failed = results.length - ok;
  out.header(`■ Done: ${ok}/${results.length} uploaded${failed ? `, ${failed} failed` : ''}`);
  if (failed > 0) {
    void vscode.window.showWarningMessage(
      `SSH Fleet: ${failed}/${results.length} uploads failed — see output`
    );
  }
  // Success path: silent — output panel header has the summary.
}

/**
 * Pull the same remote path from many servers. Each download lands at
 * <mirrorRoot>/<server>/<remote-path> so they don't collide; the active
 * editor is opened on the first successful download for quick inspection.
 */
export async function cmdDownloadFromManyServers(ctx: CommandContext): Promise<void> {
  const servers = await pickServers(ctx.config.config, 'Download from which servers?');
  if (servers.length === 0) {
    return;
  }
  const remotePath = await vscode.window.showInputBox({
    prompt: 'Remote path to fetch from each server',
    placeHolder: '/etc/hostname',
    ignoreFocusOut: true
  });
  if (!remotePath) {
    return;
  }

  const out = ctx.output;
  out.show();
  out.header(`▶ Downloading ${remotePath} from ${servers.length} server(s)`);

  let firstSuccessLocalPath: string | undefined;
  const results = await Promise.all(servers.map(async server => {
    try {
      const entry = await ctx.mirror.download(server.name, remotePath);
      out.line(server.name, `✓ → ${entry.localPath}`);
      if (!firstSuccessLocalPath) {
        firstSuccessLocalPath = entry.localPath;
      }
      return { ok: true, name: server.name };
    } catch (err) {
      out.line(server.name, `✗ ${(err as Error).message}`);
      return { ok: false, name: server.name };
    }
  }));

  const ok = results.filter(r => r.ok).length;
  const failed = results.length - ok;
  out.header(
    `■ Done: ${ok}/${results.length} downloaded${failed ? `, ${failed} failed` : ''}` +
    (firstSuccessLocalPath ? ` · mirror root: ${path.dirname(path.dirname(firstSuccessLocalPath))}` : '')
  );

  if (firstSuccessLocalPath) {
    const action = await vscode.window.showInformationMessage(
      `SSH Fleet: downloaded ${remotePath} from ${ok} server(s)`,
      'Compare All', 'Open First'
    );
    if (action === 'Open First') {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(firstSuccessLocalPath));
      await vscode.window.showTextDocument(doc);
    } else if (action === 'Compare All' && results.length >= 2) {
      // Open up to 4 successful downloads in split editors for visual diff.
      const ok = ctx.mirror.list().filter(e => e.remotePath === remotePath);
      for (let i = 0; i < Math.min(ok.length, 4); i++) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ok[i].localPath));
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
      }
    }
  } else if (failed > 0) {
    void vscode.window.showWarningMessage('SSH Fleet: all downloads failed — see output');
  }
}
