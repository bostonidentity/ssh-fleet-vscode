import * as vscode from 'vscode';
import type { AppConfig, ServerConfig } from '../config/types.js';
import type { ConnectionRegistry } from '../ssh/connection.js';
import type { SelectionState } from '../state/selection.js';
import { ServerFilterState } from '../state/serverFilter.js';
import {
  ALL_SERVERS_GROUP,
  FilterRootNode,
  FilterValueNode,
  GroupNode,
  HistoryEntryNode,
  ServerNode,
  type TreeNode
} from './serverTreeItem.js';
import { globMatch } from '../features/safety.js';


export class ServerTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private config: AppConfig;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    initialConfig: AppConfig,
    private readonly registry: ConnectionRegistry,
    onDidConfigChange: vscode.Event<AppConfig>,
    private readonly selection: SelectionState,
    private readonly extensionUri: vscode.Uri,
    private readonly filter: ServerFilterState
  ) {
    this.config = initialConfig;
    this.subscriptions.push(onDidConfigChange(c => {
      this.config = c;
      // Drop selections for servers no longer in config.
      const known = new Set(c.servers.map(s => s.name));
      this.selection.prune(known, new Set(c.tasks.map(t => t.name)));
      this.emitter.fire(undefined);
    }));
    this.subscriptions.push(registry.onChange(() => {
      this.emitter.fire(undefined);
    }));
    this.subscriptions.push(selection.onDidChange(() => {
      this.emitter.fire(undefined);
    }));
    // Filter change → auto-deselect hidden servers + refresh tree.
    this.subscriptions.push(filter.onDidChange(() => {
      this.applyFilterToSelection();
      this.emitter.fire(undefined);
    }));
    // Initial reconcile: both `filter` and `selection` hydrate from their
    // own mementos independently, so a previous session could leave us
    // with selection entries that don't pass the loaded filter (operator
    // saw them in the tree last time because they were connected — but
    // connections are gone after a window restart). Without this, those
    // stale selections persist invisibly and Connect Selected would
    // resurrect hidden servers.
    this.applyFilterToSelection();
  }

  /** True when the operator has engaged with this server at all in this
   *  session — connected, connecting, or in an error state. Used to keep
   *  in-use servers visible even when the active filter would otherwise
   *  hide them: the operator's mental model is "I'm working with this
   *  server, don't make it disappear because I narrowed env=…". Only
   *  fully-idle servers are hidden by filter. */
  private isInUse(name: string): boolean {
    const state = this.registry.get(name)?.state ?? 'idle';
    return state !== 'idle';
  }

  private isVisible(s: ServerConfig): boolean {
    return this.filter.passes(s) || this.isInUse(s.name);
  }

  /** Drop checkbox selection for any server that no longer passes the filter. */
  private applyFilterToSelection(): void {
    if (!this.filter.isActive()) return;
    for (const name of this.selection.servers) {
      const s = this.config.servers.find(x => x.name === name);
      if (!s || !this.filter.passes(s)) {
        this.selection.setServer(name, false);
      }
    }
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  /** Wire onDidChangeCheckboxState from a TreeView into the selection state. */
  bindCheckbox(treeView: vscode.TreeView<TreeNode>): vscode.Disposable {
    return treeView.onDidChangeCheckboxState(ev => {
      const cap = this.config.settings.maxServersPerAction;
      let blocked = false;
      for (const [item, newState] of ev.items) {
        if (item.kind === 'server') {
          const checked = newState === vscode.TreeItemCheckboxState.Checked;
          // Refuse when ticking would push the selection past the cap.
          // The user has to untick something (or raise the cap in config)
          // to proceed — there's no in-UI override by design.
          if (
            checked &&
            cap > 0 &&
            !this.selection.isServerSelected(item.server.name) &&
            this.selection.servers.length >= cap
          ) {
            blocked = true;
            continue;
          }
          this.selection.setServer(item.server.name, checked);
        } else if (item.kind === 'group') {
          // Toggling a group checkbox cascades to all its members.
          // Synthetic "All servers" group → cascade across every visible
          // server (no `groups:` field needed, by definition). Real
          // groups → only servers whose `groups:` includes the name.
          const checked = newState === vscode.TreeItemCheckboxState.Checked;
          const members = item.group === ALL_SERVERS_GROUP
            ? this.config.servers.filter(s => this.isVisible(s))
            : this.config.servers.filter(s => s.groups.includes(item.group));
          if (checked && cap > 0) {
            // Compute the post-cascade selection size and refuse the
            // whole cascade if it would push past the cap.
            const cur = new Set(this.selection.servers);
            let projected = cur.size;
            for (const m of members) if (!cur.has(m.name)) projected++;
            if (projected > cap) {
              blocked = true;
              continue;
            }
          }
          for (const m of members) {
            this.selection.setServer(m.name, checked);
          }
        } else if (item.kind === 'filter-value') {
          // Toggling a filter-value checkbox flips that env/module in/out
          // of the active filter set — multi-select happens entirely in the
          // sidebar (no QuickPick popup).
          const next = newState === vscode.TreeItemCheckboxState.Checked;
          if (item.axis === 'env') {
            const cur = new Set(this.filter.selectedEnvs);
            if (next) cur.add(item.value); else cur.delete(item.value);
            this.filter.setEnvs([...cur]);
          } else {
            const cur = new Set(this.filter.selectedModules);
            if (next) cur.add(item.value); else cur.delete(item.value);
            this.filter.setModules([...cur]);
          }
        }
      }
      if (blocked) {
        void vscode.window.showWarningMessage(
          `SSH Fleet: maxServersPerAction = ${cap} — untick a server first, ` +
          `or raise the cap in your config (settings.maxServersPerAction).`
        );
        // Re-render so the rejected check visually un-ticks itself
        // (VSCode optimistically renders the new check state from the event;
        // we have to fire the change to revert it).
        this.refresh();
      }
    });
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      const out: TreeNode[] = [];
      // Filter rows render before any server — compact, content-sized.
      out.push(...this.filterRoots());

      // Visibility = passes the filter OR is in-use (connected / connecting /
      // error). Keeps actively-used servers from disappearing when the
      // operator narrows the filter mid-session — see `isInUse`.
      const visible = this.config.servers.filter(s => this.isVisible(s));
      const grouped = visible.filter(s => s.groups.length > 0);
      const ungrouped = visible.filter(s => s.groups.length === 0);

      // When NO server has explicit groups, wrap them all under a single
      // synthetic "All servers (N)" node — its cascade checkbox lets the
      // operator batch-select every server in one click. When some
      // servers are explicitly grouped, the ungrouped subset still
      // renders flat at root (no synthetic wrapper).
      if (grouped.length === 0 && ungrouped.length > 0) {
        const node = new GroupNode(ALL_SERVERS_GROUP, ungrouped.length);
        node.checkboxState = checkboxStateForList(ungrouped, this.selection);
        out.push(node);
        return out;
      }

      for (const s of ungrouped) out.push(this.makeServerNode(s));
      const groups = this.groupServers(grouped);
      for (const [g, list] of groups.entries()) {
        const node = new GroupNode(g, list.length);
        node.checkboxState = checkboxStateForList(list, this.selection);
        out.push(node);
      }
      return out;
    }
    if (element.kind === 'group') {
      const visible = this.config.servers.filter(s => this.isVisible(s));
      // Synthetic "All servers" group → expand to every visible server
      // (none of which are explicitly grouped). Real groups → bucket as
      // before via `groupServers`.
      if (element.group === ALL_SERVERS_GROUP) {
        return visible.map(server => this.makeServerNode(server));
      }
      const list = this.groupServers(visible.filter(s => s.groups.length > 0)).get(element.group) ?? [];
      return list.map(server => this.makeServerNode(server));
    }
    if (element.kind === 'filter-root' && element.axis === 'env') {
      const selected = new Set(this.filter.selectedEnvs);
      return ServerFilterState.availableEnvs(this.config.servers)
        .map(v => new FilterValueNode('env', v, selected.has(v)));
    }
    if (element.kind === 'filter-root' && element.axis === 'module') {
      const selected = new Set(this.filter.selectedModules);
      return ServerFilterState.availableModules(this.config.servers)
        .map(v => new FilterValueNode('module', v, selected.has(v)));
    }
    if (element.kind === 'filter-root' && element.axis === 'recent') {
      // Sort: pinned first (newest-pinned on top), then unpinned by ts desc.
      // This matches the dropdown design we'd discussed earlier — operators
      // see their "kept" combos at the top, recent activity below.
      const history = this.filter.getHistory();
      const pinned = history.filter(e => e.pinned).sort((a, b) => b.ts - a.ts);
      const recent = history.filter(e => !e.pinned).sort((a, b) => b.ts - a.ts);
      return [...pinned, ...recent].map(e =>
        new HistoryEntryNode(e.envs, e.mods, e.ts, !!e.pinned)
      );
    }
    return [];
  }

  /**
   * Top-level filter rows: Env (expandable), Module (expandable), Text
   * (click → input box), Clear (only when filter is active).
   */
  private filterRoots(): FilterRootNode[] {
    const envs = this.filter.selectedEnvs;
    const mods = this.filter.selectedModules;
    const text = this.filter.filterText;
    const rows: FilterRootNode[] = [];
    rows.push(new FilterRootNode(
      'env', 'Env', envs.length === 0 ? '(any)' : envs.join(', '),
      'globe', { expandable: true }
    ));
    rows.push(new FilterRootNode(
      'module', 'Module', mods.length === 0 ? '(any)' : mods.join(', '),
      'package', { expandable: true }
    ));
    rows.push(new FilterRootNode(
      'text', 'Text', text || '(none)',
      'search', { expandable: false, commandId: 'ssh-fleet.filterByText' }
    ));
    const history = this.filter.getHistory();
    if (history.length > 0) {
      const pinnedCount = history.filter(e => e.pinned).length;
      const total = history.length;
      const desc = pinnedCount > 0
        ? `${total} (${pinnedCount} ★)`
        : `${total}`;
      rows.push(new FilterRootNode(
        'recent', 'Recent', desc,
        'history', { expandable: true }
      ));
    }
    if (this.filter.isActive()) {
      rows.push(new FilterRootNode(
        'clear', 'Clear filter', '',
        'close', { expandable: false, commandId: 'ssh-fleet.filterClear' }
      ));
    }
    return rows;
  }

  /**
   * Bucket the given servers by their declared `groups`. Callers pass only
   * the subset they want grouped — typically servers with a non-empty
   * `groups:` array — so ungrouped servers can render flat at root level
   * without a synthetic wrapper.
   */
  private groupServers(servers: ServerConfig[]): Map<string, ServerConfig[]> {
    const map = new Map<string, ServerConfig[]>();
    for (const s of servers) {
      for (const g of s.groups) {
        const list = map.get(g) ?? [];
        list.push(s);
        map.set(g, list);
      }
    }
    return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  private makeServerNode(server: ServerConfig): ServerNode {
    const conn = this.registry.get(server.name);
    const state = conn?.state ?? 'idle';
    const err = conn?.errorMessage;
    const warn = warningLabelFor(server, this.config);
    const selected = this.selection.isServerSelected(server.name);
    return new ServerNode(server, state, err, warn, selected, this.extensionUri);
  }

  dispose(): void {
    for (const s of this.subscriptions) {
      s.dispose();
    }
    this.emitter.dispose();
  }
}

/** All / none / partial → checkbox state for a group cascade. Partial is
 *  rendered as Checked so the next click toggles the whole group off
 *  (matching how VSCode tree groups behave for any tri-state cascade). */
function checkboxStateForList(
  list: readonly ServerConfig[],
  selection: SelectionState
): vscode.TreeItemCheckboxState {
  const all = list.every(s => selection.isServerSelected(s.name));
  const none = list.every(s => !selection.isServerSelected(s.name));
  if (all) return vscode.TreeItemCheckboxState.Checked;
  if (none) return vscode.TreeItemCheckboxState.Unchecked;
  return vscode.TreeItemCheckboxState.Checked;
}

function warningLabelFor(
  server: ServerConfig,
  config: AppConfig
): { label: string; color: string } | undefined {
  for (const p of config.safety.serverWarnPatterns) {
    if (globMatch(p.pattern, server.name) || globMatch(p.pattern, server.host)) {
      return { label: p.label, color: p.color };
    }
  }
  return undefined;
}
