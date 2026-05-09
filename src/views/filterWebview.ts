import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import type { ConfigStore } from '../config/loader.js';
import { ServerFilterState } from '../state/serverFilter.js';
import { log } from '../util/logger.js';

interface FilterSnapshot {
  availableEnvs: string[];
  availableModules: string[];
  filterEnvs: string[];
  filterModules: string[];
  filterText: string;
}

type FilterExtToWeb =
  | { type: 'state'; state: FilterSnapshot };

type FilterWebToExt =
  | { type: 'ready' }
  | { type: 'filterSet'; envs?: string[]; modules?: string[]; text?: string }
  | { type: 'filterClear' };

const VIEW_ID = 'ssh-fleet.filter';

/**
 * Sidebar webview rendering the server filter strip (env / module multi-select
 * dropdowns + text input + clear). Lives above the Servers TreeView so the
 * filter is always visible without taking up the main panel header. State
 * lives in ServerFilterState; this view is a thin reflector.
 */
export class FilterWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = VIEW_ID;

  private view: vscode.WebviewView | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly config: ConfigStore,
    private readonly serverFilter: ServerFilterState
  ) {
    // Re-push when filter state changes (so other UI mutating the filter is
    // mirrored here) or when the active config changes (so available envs /
    // modules reflect the new server list).
    this.subs.push(this.serverFilter.onDidChange(() => this.pushState()));
    this.subs.push(this.config.onDidChange(() => this.pushState()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    void this.renderHtml(view);
    this.subs.push(view.webview.onDidReceiveMessage((m: FilterWebToExt) => this.onMessage(m)));
    this.subs.push(view.onDidDispose(() => { this.view = undefined; }));
  }

  private async renderHtml(view: vscode.WebviewView): Promise<void> {
    const ext = this.extensionUri;
    const htmlPath = vscode.Uri.joinPath(ext, 'media', 'filter', 'index.html');
    const stylePath = vscode.Uri.joinPath(ext, 'media', 'filter', 'style.css');
    const scriptPath = vscode.Uri.joinPath(ext, 'media', 'filter', 'main.js');

    const styleUri = view.webview.asWebviewUri(stylePath);
    const scriptUri = view.webview.asWebviewUri(scriptPath);
    const cspSource = view.webview.cspSource;
    const nonce = crypto.randomBytes(16).toString('base64');

    let html: string;
    try {
      html = await fs.readFile(htmlPath.fsPath, 'utf-8');
    } catch (err) {
      log.error('Failed to read filter webview HTML', err);
      view.webview.html = '<html><body>Failed to load SSH Fleet filter UI.</body></html>';
      return;
    }
    html = html
      .replace(/\$\{cspSource\}/g, cspSource)
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{styleUri\}/g, styleUri.toString())
      .replace(/\$\{scriptUri\}/g, scriptUri.toString());
    view.webview.html = html;
  }

  private buildSnapshot(): FilterSnapshot {
    const servers = this.config.config.servers;
    return {
      availableEnvs: ServerFilterState.availableEnvs(servers),
      availableModules: ServerFilterState.availableModules(servers),
      filterEnvs: this.serverFilter.selectedEnvs,
      filterModules: this.serverFilter.selectedModules,
      filterText: this.serverFilter.filterText
    };
  }

  private pushState(): void {
    if (!this.view) return;
    void this.view.webview.postMessage({ type: 'state', state: this.buildSnapshot() } as FilterExtToWeb);
  }

  private onMessage(msg: FilterWebToExt): void {
    switch (msg.type) {
      case 'ready':
        this.pushState();
        return;
      case 'filterSet':
        if (msg.envs !== undefined) this.serverFilter.setEnvs(msg.envs);
        if (msg.modules !== undefined) this.serverFilter.setModules(msg.modules);
        if (msg.text !== undefined) this.serverFilter.setText(msg.text);
        return;
      case 'filterClear':
        this.serverFilter.clear();
        return;
    }
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs.length = 0;
  }
}
