import * as vscode from 'vscode';
import type { CommandContext } from './context.js';
import { buildUri, SCHEME as SSH_SCHEME } from '../views/sshFileSystemProvider.js';
import { enforceServerCap } from './helpers.js';

const SUGGEST_HISTORY_KEY = 'ssh-fleet.multiEditPathHistory.v1';

interface SiblingUri {
  uri: vscode.Uri;
  serverName: string;
  remotePath: string;
}

/**
 * Parse an ssh-fleet:// editor URI into its server + path components.
 * Returns undefined if the URI isn't ours.
 */
function parseSshFleetUri(uri: vscode.Uri): SiblingUri | undefined {
  if (uri.scheme !== SSH_SCHEME || !uri.authority) return undefined;
  return {
    uri,
    serverName: uri.authority,
    remotePath: uri.path === '' ? '/' : uri.path
  };
}

/**
 * Find all currently-open documents that share the same remote path as the
 * given URI but on a different server — these are this editor's "siblings"
 * for Save All / cross-server diff purposes.
 */
function findSiblingDocs(activeUri: vscode.Uri): SiblingUri[] {
  const active = parseSshFleetUri(activeUri);
  if (!active) return [];
  const out: SiblingUri[] = [];
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== SSH_SCHEME) continue;
    const parsed = parseSshFleetUri(doc.uri);
    if (!parsed) continue;
    if (parsed.remotePath !== active.remotePath) continue;
    if (parsed.serverName === active.serverName) continue;
    out.push(parsed);
  }
  return out;
}

/**
 * Open the same remote path on every checked server, side by side in split
 * editors (ViewColumn.Beside cascades). Each editor is a normal ssh-fleet://
 * FSP-backed document — saves go via SFTP just like single-server edits.
 */
export async function cmdOpenOnSelected(ctx: CommandContext): Promise<void> {
  const servers = ctx.selection.servers;
  if (servers.length === 0) {
    void vscode.window.showWarningMessage(
      'SSH Fleet: tick at least one server first, then re-run "Open File on Selected Servers".'
    );
    return;
  }
  if (!enforceServerCap(ctx, servers.length, 'Open File on Selected Servers')) return;

  const remotePath = await promptRemotePath(ctx, servers);
  if (!remotePath) return;

  const opened: { server: string; ok: boolean; reason?: string }[] = [];
  for (let i = 0; i < servers.length; i++) {
    const serverName = servers[i];
    const uri = buildUri(serverName, remotePath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      // First file → take the focused/active column; rest open beside.
      const column = i === 0 ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
      await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
      opened.push({ server: serverName, ok: true });
    } catch (err) {
      opened.push({ server: serverName, ok: false, reason: (err as Error).message });
    }
  }

  await pushPathHistory(ctx, remotePath);

  const ok = opened.filter(o => o.ok).length;
  const failed = opened.length - ok;
  if (failed > 0) {
    const summary = opened.filter(o => !o.ok).map(o => `  ${o.server}: ${o.reason ?? 'unknown'}`).join('\n');
    void vscode.window.showWarningMessage(
      `SSH Fleet: opened ${ok}/${opened.length}; ${failed} failed.\n${summary}`
    );
  } else {
    void vscode.window.showInformationMessage(
      `SSH Fleet: opened ${ok} editor(s) — edit then "Save All to Servers" applies to every sibling.`
    );
  }
}

/**
 * From the active ssh-fleet:// editor, write its current content to every
 * sibling URI (same remote path, different server) — including unsaved
 * editors that are siblings. Useful for fan-out config edits.
 */
export async function cmdSaveAllToServers(ctx: CommandContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage('SSH Fleet: open a remote file first.');
    return;
  }
  const active = parseSshFleetUri(editor.document.uri);
  if (!active) {
    void vscode.window.showWarningMessage(
      `SSH Fleet: active editor isn't a remote file (${editor.document.uri.scheme}://).`
    );
    return;
  }

  const siblings = findSiblingDocs(editor.document.uri);
  // Save the active editor's local content first so the buffer is what gets fanned out.
  if (editor.document.isDirty) {
    await editor.document.save();
  }

  // Read active content as bytes for SFTP-style fan-out write.
  const text = editor.document.getText();
  const data = new TextEncoder().encode(text);

  // Confirm if multiple targets.
  const totalTargets = siblings.length + 1; // active + siblings
  const proceed = await vscode.window.showWarningMessage(
    `Apply ${active.remotePath} to ${totalTargets} ${totalTargets === 1 ? 'server' : 'servers'}?`,
    {
      modal: true,
      detail: [active.serverName, ...siblings.map(s => s.serverName)].map(n => `• ${n}`).join('\n')
    },
    'Save All'
  );
  if (proceed !== 'Save All') return;

  // The active editor's save above already pushed its content via FSP to its
  // own server. We only need to write to the siblings now.
  let ok = 1; // active counted as success
  let failed = 0;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Saving to ${siblings.length + 1} server(s)…` },
    async (progress) => {
      const total = siblings.length;
      for (let i = 0; i < siblings.length; i++) {
        const sib = siblings[i];
        progress.report({
          message: `${sib.serverName} (${i + 1}/${total})`,
          increment: 100 / Math.max(total, 1)
        });
        try {
          await vscode.workspace.fs.writeFile(sib.uri, data);
          ok += 1;
        } catch (err) {
          failed += 1;
          ctx.output.line(sib.serverName, `✗ Save All failed: ${(err as Error).message}`);
        }
      }
    }
  );

  if (failed > 0) {
    void vscode.window.showWarningMessage(
      `SSH Fleet: ${ok}/${ok + failed} saved; see SSH Fleet output for failures.`
    );
  } else {
    void vscode.window.showInformationMessage(
      `SSH Fleet: ${active.remotePath} saved to ${ok} server(s).`
    );
  }
}

/**
 * Open vscode.diff between the active editor and another sibling — picks
 * which sibling via QuickPick when there are >1 siblings, auto-picks when
 * there's exactly one.
 */
export async function cmdDiffSiblings(_ctx: CommandContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const active = parseSshFleetUri(editor.document.uri);
  if (!active) {
    void vscode.window.showWarningMessage(
      `SSH Fleet: active editor isn't a remote file.`
    );
    return;
  }
  const siblings = findSiblingDocs(editor.document.uri);
  if (siblings.length === 0) {
    void vscode.window.showInformationMessage(
      'SSH Fleet: no other server has the same remote path open. Use "Open File on Selected Servers" first.'
    );
    return;
  }
  let target = siblings[0];
  if (siblings.length > 1) {
    const pick = await vscode.window.showQuickPick(
      siblings.map(s => ({ label: s.serverName, sib: s })),
      { title: `Compare ${active.serverName} ↔ which server?` }
    );
    if (!pick) return;
    target = pick.sib;
  }
  await vscode.commands.executeCommand(
    'vscode.diff',
    editor.document.uri,
    target.uri,
    `${active.serverName} ↔ ${target.serverName}: ${active.remotePath}`
  );
}

// ---------- helpers ----------

async function promptRemotePath(ctx: CommandContext, servers: string[]): Promise<string | undefined> {
  // Suggest the common cwd if we know it for these servers.
  const common = ctx.cwd.commonCwd(servers);
  const recent = recallPathHistory(ctx);
  const seed = common && common !== '~' ? common + '/' : (recent[0] ?? '/');
  const value = await vscode.window.showInputBox({
    title: `Open file on ${servers.length} selected server(s)`,
    prompt: `Same remote path will be opened in ${servers.length} split editors`,
    value: seed,
    valueSelection: [seed.length, seed.length],
    ignoreFocusOut: true,
    placeHolder: '/etc/nginx/nginx.conf'
  });
  return value?.trim() || undefined;
}

function recallPathHistory(ctx: CommandContext): string[] {
  return ctx.extension.globalState.get<string[]>(SUGGEST_HISTORY_KEY) ?? [];
}

async function pushPathHistory(ctx: CommandContext, p: string): Promise<void> {
  const cur = recallPathHistory(ctx);
  const next = [p, ...cur.filter(x => x !== p)].slice(0, 20);
  await ctx.extension.globalState.update(SUGGEST_HISTORY_KEY, next);
}

/**
 * Helper used by the FSP single-editor 'Push to Remote' button to know if
 * Save All would help — surfaces a clue in the editor title bar.
 */
export function activeEditorHasSiblings(): boolean {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return false;
  return findSiblingDocs(editor.document.uri).length > 0;
}

/**
 * Set/unset the 'ssh-fleet.activeFileHasSiblings' context key whenever the
 * active editor changes. Used by editor/title menu when-clause.
 */
export function registerSiblingTracker(ctx: vscode.ExtensionContext): vscode.Disposable {
  const tag = (): void => {
    void vscode.commands.executeCommand(
      'setContext',
      'ssh-fleet.activeFileHasSiblings',
      activeEditorHasSiblings()
    );
    void vscode.commands.executeCommand(
      'setContext',
      'ssh-fleet.activeFileIsRemote',
      vscode.window.activeTextEditor?.document.uri.scheme === SSH_SCHEME
    );
  };
  const subs: vscode.Disposable[] = [
    vscode.window.onDidChangeActiveTextEditor(tag),
    vscode.workspace.onDidOpenTextDocument(tag),
    vscode.workspace.onDidCloseTextDocument(tag)
  ];
  tag();
  for (const s of subs) ctx.subscriptions.push(s);
  return new vscode.Disposable(() => {
    for (const s of subs) s.dispose();
  });
}
