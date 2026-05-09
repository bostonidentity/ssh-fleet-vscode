import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommandContext } from './context.js';
import { confirmAndSwitchActiveConfig } from './helpers.js';

/** Run the first-run wizard explicitly (also auto-runs on activation if unset). */
export async function cmdSetupWorkspace(ctx: CommandContext): Promise<void> {
  const chosen = await ctx.workspace.runFirstRunWizard();
  if (chosen) {
    void vscode.window.showInformationMessage(
      `SSH Fleet: workspace set to ${chosen}`,
      'Open Folder'
    ).then(action => {
      if (action === 'Open Folder') {
        void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(chosen));
      }
    });
  }
}

/** Re-pick the workspace (overrides the existing one). */
export async function cmdSwitchWorkspace(ctx: CommandContext): Promise<void> {
  const proceed = await vscode.window.showWarningMessage(
    `Switch workspace?`,
    {
      modal: true,
      detail:
        `Current: ${ctx.workspace.root ?? '(none)'}\n\n` +
        `Switching reloads all configs and points mirror / known_hosts at the new directory. Mirror files in the old workspace stay on disk but are no longer tracked.`
    },
    'Switch…'
  );
  if (proceed !== 'Switch…') {
    return;
  }
  await cmdSetupWorkspace(ctx);
}

/** Pick which config in <workdir>/config/ should be active. Updates .last_config. */
export async function cmdSwitchActiveConfig(ctx: CommandContext, arg?: unknown): Promise<void> {
  if (!ctx.workspace.root) {
    void vscode.window.showWarningMessage('SSH Fleet: workspace not set yet.');
    return;
  }
  // Tree click passes `{ absPath }`; command-palette invocation passes nothing.
  const fromArg = (arg as { absPath?: string } | undefined)?.absPath;
  if (fromArg) {
    await confirmAndSwitchActiveConfig(ctx, fromArg);
    return;
  }
  const configs = await ctx.workspace.listConfigs();
  if (configs.length === 0) {
    void vscode.window.showInformationMessage(
      'SSH Fleet: no config files in this workspace yet. Use "Open Config File" to scaffold one.'
    );
    return;
  }
  const active = await ctx.workspace.resolveActiveConfig();
  const activeBase = active ? path.basename(active) : undefined;

  const pick = await vscode.window.showQuickPick(
    configs.map(name => ({
      label: name,
      description: name === activeBase ? '$(check) active' : undefined,
      name
    })),
    { title: `Active config in ${ctx.workspace.configDir()}` }
  );
  if (!pick) {
    return;
  }
  const target = path.join(ctx.workspace.configDir()!, pick.name);
  const switched = await confirmAndSwitchActiveConfig(ctx, target);
  if (switched) {
    void vscode.window.showInformationMessage(`SSH Fleet: switched to ${pick.name}`);
  }
}

/** Reveal the workspace root in the OS file manager. */
export async function cmdRevealWorkspace(ctx: CommandContext): Promise<void> {
  if (!ctx.workspace.root) {
    void vscode.window.showWarningMessage('SSH Fleet: workspace not set yet.');
    return;
  }
  await fs.mkdir(ctx.workspace.root, { recursive: true });
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(ctx.workspace.root));
}
