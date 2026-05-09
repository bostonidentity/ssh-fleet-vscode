import * as vscode from 'vscode';
import type { CommandContext } from './context.js';
import { ServerFilterState } from '../state/serverFilter.js';

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
