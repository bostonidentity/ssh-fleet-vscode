import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Workspace } from '../workspace.js';
import type { ConfigStore } from '../config/loader.js';

/**
 * One row per `*.yml` / `*.yaml` file in `<workspace>/config/`. The active
 * config gets a filled-circle icon; others get a hollow one. Clicking a row
 * fires `ssh-fleet.switchActiveConfig` so the operator can flip between
 * configs without leaving the sidebar — replaces the dropdown that used to
 * live in the main panel header.
 */
export class ConfigNode extends vscode.TreeItem {
  readonly kind = 'config' as const;
  constructor(readonly absPath: string, readonly active: boolean) {
    const name = path.basename(absPath);
    super(name, vscode.TreeItemCollapsibleState.None);
    this.description = active ? 'active' : '';
    this.iconPath = new vscode.ThemeIcon(active ? 'circle-filled' : 'circle-outline');
    this.contextValue = active ? 'config-active' : 'config';
    this.tooltip = absPath;
    this.command = active
      ? undefined
      : { command: 'ssh-fleet.switchActiveConfig', title: 'Activate', arguments: [{ absPath }] };
  }
}

export class ConfigsTreeProvider implements vscode.TreeDataProvider<ConfigNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ConfigNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly workspace: Workspace,
    config: ConfigStore
  ) {
    // Re-render whenever the active config or the underlying config dir
    // contents change.
    this.subs.push(this.workspace.onDidChange(() => this.emitter.fire(undefined)));
    this.subs.push(config.onDidChange(() => this.emitter.fire(undefined)));
    const dir = this.workspace.configDir();
    if (dir) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(dir, '*.{yml,yaml}')
      );
      watcher.onDidCreate(() => this.emitter.fire(undefined));
      watcher.onDidDelete(() => this.emitter.fire(undefined));
      this.subs.push(watcher);
    }
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: ConfigNode): vscode.TreeItem {
    return node;
  }

  async getChildren(): Promise<ConfigNode[]> {
    const dir = this.workspace.configDir();
    if (!dir) return [];
    const names = await this.workspace.listConfigs();
    const active = await this.workspace.resolveActiveConfig();
    return names.map(name => new ConfigNode(path.join(dir, name), path.join(dir, name) === active));
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.emitter.dispose();
  }
}
