import * as vscode from 'vscode';
import type { ConnectionRegistry } from '../ssh/connection.js';
import type { SelectionState } from '../state/selection.js';
import type { ServerFilterState } from '../state/serverFilter.js';
import type { AppConfig } from '../config/types.js';

/**
 * Status bar entry showing the SSH Fleet session at a glance:
 *
 *   $(server) SSH Fleet · 3/5 selected · 2 connected
 *
 * Click → focus the SSH Fleet Console panel.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subs: vscode.Disposable[] = [];
  private config: AppConfig;

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly selection: SelectionState,
    initialConfig: AppConfig,
    private readonly filter: ServerFilterState
  ) {
    this.config = initialConfig;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'ssh-fleet.openPanel';
    this.subs.push(this.registry.onChange(() => this.update()));
    this.subs.push(this.filter.onDidChange(() => this.update()));
    this.update();
    this.item.show();
  }

  refresh(newConfig?: AppConfig): void {
    if (newConfig) this.config = newConfig;
    this.update();
  }

  private update(): void {
    const total = this.config.servers.length;
    const selected = this.selection.servers.length;
    const connected = this.registry.connectedCount();
    if (total === 0) {
      this.item.text = '$(server) SSH Fleet';
      this.item.tooltip = 'SSH Fleet — no servers configured. Click to open Console.';
      return;
    }
    const filterTag = this.filter.isActive() ? ` · 🔍 ${this.filter.summary()}` : '';
    this.item.text = `$(server) SSH Fleet ${selected}/${total} · ${connected}${filterTag}`;
    this.item.tooltip = new vscode.MarkdownString(
      `**SSH Fleet**\n\n` +
      `selected: ${selected}/${total}\n\n` +
      `connected: ${connected}\n\n` +
      (this.filter.isActive() ? `filter: \`${this.filter.summary()}\`\n\n` : '') +
      `_click to open the Console panel_`
    );
  }

  dispose(): void {
    for (const s of this.subs) {
      s.dispose();
    }
    this.item.dispose();
  }
}
