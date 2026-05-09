import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommandContext } from './context.js';

/**
 * Open the active config file. If the workspace has no configs yet, create
 * a starter `default.yml` first.
 */
export async function cmdOpenConfig(ctx: CommandContext): Promise<void> {
  const root = ctx.workspace.root;
  if (!root) {
    const choice = await vscode.window.showWarningMessage(
      'SSH Fleet: workspace not set. Set it up now?',
      'Setup Workspace…',
      'Cancel'
    );
    if (choice === 'Setup Workspace…') {
      await vscode.commands.executeCommand('ssh-fleet.setupWorkspace');
    }
    return;
  }

  const configDir = ctx.workspace.configDir()!;
  await fs.mkdir(configDir, { recursive: true });

  let target = await ctx.workspace.resolveActiveConfig();
  if (!target) {
    target = path.join(configDir, 'default.yml');
    try {
      await fs.access(target);
    } catch {
      await fs.writeFile(target, STARTER_CONFIG, 'utf-8');
    }
    await ctx.workspace.setActiveConfig(target);
  }

  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc);
}

export async function cmdReloadConfig(ctx: CommandContext): Promise<void> {
  const ok = await ctx.config.reload();
  if (!ok) {
    // reload() already showed an error modal — don't stack a competing
    // "reloaded successfully" toast on top of it.
    return;
  }
  const sources = ctx.config.sources;
  void vscode.window.showInformationMessage(
    sources.length === 0
      ? 'SSH Fleet: config reloaded — no files found.'
      : `SSH Fleet: config reloaded from ${sources.length} file(s).`
  );
}

/** Show a QuickPick of currently-connected servers; selecting one opens its Terminal. */
export async function cmdShowConnected(ctx: CommandContext): Promise<void> {
  const conns = ctx.registry.list();
  if (conns.length === 0) {
    void vscode.window.showInformationMessage('SSH Fleet: no active connections.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    conns.map(c => ({
      label: c.server.name,
      description: `${c.state}${c.errorMessage ? ` — ${c.errorMessage}` : ''}`,
      server: c.server
    })),
    { title: 'Active connections — pick one to focus its Terminal' }
  );
  if (pick) {
    void vscode.commands.executeCommand('ssh-fleet.openTerminal', { serverName: pick.server.name });
  }
}

const STARTER_CONFIG = `# SSH Fleet config — see README for the full schema.
settings:
  defaultTimeout: 60
  keepaliveSeconds: 30

servers:
  - name: example-01
    host: 127.0.0.1
    port: 22
    user: root
    auth:
      type: agent
    groups: [demo]

aliases:
  ll: "ls -ltrah"

bookmarks:
  - /var/log/

safety:
  serverWarnPatterns:
    - pattern: "*prod*"
      label: PROD
      color: "#dc2626"
  autoBackup:
    enabled: false
    backupDir: /opt/backup
    commands: [rm, mv, cp, ">", sed]
  destCheck:
    enabled: false
    commands: [cp, mv, ">"]

tasks:
  - name: uptime
    command: uptime
    timeout: 10
`;
