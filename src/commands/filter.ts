import * as vscode from 'vscode';
import type { CommandContext } from './context.js';
import { ServerFilterState } from '../state/serverFilter.js';
import { pickServer } from './serverPicker.js';

export async function cmdFilterByEnv(ctx: CommandContext): Promise<void> {
  await pickAndApply(
    ctx,
    'environment',
    'Filter by environment (multi-select)',
    ctx.serverFilter.selectedEnvs,
    values => ctx.serverFilter.setEnvs(values)
  );
}

export async function cmdFilterByModule(ctx: CommandContext): Promise<void> {
  await pickAndApply(
    ctx,
    'module',
    'Filter by module (multi-select)',
    ctx.serverFilter.selectedModules,
    values => ctx.serverFilter.setModules(values)
  );
}

export async function cmdFilterByText(ctx: CommandContext): Promise<void> {
  const next = await vscode.window.showInputBox({
    title: 'Filter servers (text)',
    prompt: 'matches name / host / groups (case-insensitive)',
    value: ctx.serverFilter.filterText
  });
  if (next === undefined) return;
  ctx.serverFilter.setText(next);
}

export function cmdFilterClear(ctx: CommandContext): void {
  ctx.serverFilter.clear();
}

/** Apply a history entry — sets envs + mods to the recorded combo.
 *  Wired to the click action on HistoryEntryNode; arg shape is
 *  `{ envs, mods }`. */
export function cmdApplyHistoryEntry(ctx: CommandContext, arg: unknown): void {
  const a = arg as { envs?: unknown; mods?: unknown } | undefined;
  if (!a) return;
  const envs = Array.isArray(a.envs) ? a.envs.filter((v): v is string => typeof v === 'string') : [];
  const mods = Array.isArray(a.mods) ? a.mods.filter((v): v is string => typeof v === 'string') : [];
  ctx.serverFilter.applyHistoryEntry(envs, mods);
}

/** Toggle pin on the right-clicked HistoryEntryNode. TreeView passes
 *  the node itself as the arg. */
export function cmdTogglePinHistoryEntry(ctx: CommandContext, arg: unknown): void {
  const node = arg as { envs?: unknown; mods?: unknown } | undefined;
  if (!node || !Array.isArray(node.envs) || !Array.isArray(node.mods)) return;
  ctx.serverFilter.togglePin(
    node.envs.filter((v): v is string => typeof v === 'string'),
    node.mods.filter((v): v is string => typeof v === 'string')
  );
}

/** Remove all unpinned entries from the current config's history.
 *  Pinned entries survive. */
export function cmdClearRecentHistory(ctx: CommandContext): void {
  ctx.serverFilter.clearRecent();
}

/** Right-click on a server → SET filter to this server's env + module
 *  (whichever are present). Replaces current env/module selections —
 *  the operator is asking "show me servers like this one", which means
 *  the new filter should be exactly this server's metadata, not a
 *  union with whatever they had before. Text filter is left untouched. */
export async function cmdFilterByServerMeta(ctx: CommandContext, arg: unknown): Promise<void> {
  const server = await pickServer(ctx.config.config, arg, 'Filter by which server’s env + module?');
  if (!server) return;
  const env = server.meta?.environment;
  const mod = server.meta?.module;
  if (!env && !mod) {
    void vscode.window.showInformationMessage(
      `SSH Fleet: server "${server.name}" has no meta.environment or meta.module set.`
    );
    return;
  }
  if (env) ctx.serverFilter.setEnvs([env]);
  if (mod) ctx.serverFilter.setModules([mod]);
}

async function pickAndApply(
  ctx: CommandContext,
  metaKey: 'environment' | 'module',
  title: string,
  current: string[],
  apply: (values: string[]) => void
): Promise<void> {
  const values = metaKey === 'environment'
    ? ServerFilterState.availableEnvs(ctx.config.config.servers)
    : ServerFilterState.availableModules(ctx.config.config.servers);
  if (values.length === 0) {
    void vscode.window.showInformationMessage(
      `SSH Fleet: no servers expose a "${metaKey}" field — set meta.${metaKey} on at least one server first.`
    );
    return;
  }
  const items: vscode.QuickPickItem[] = values.map(v => ({
    label: v,
    picked: current.includes(v)
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title,
    canPickMany: true,
    placeHolder: 'Tick the values you want to keep visible — leave all unticked to clear this filter'
  });
  if (!picked) return;
  apply(picked.map(p => p.label));
}
