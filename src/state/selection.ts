import * as vscode from 'vscode';
import { log } from '../util/logger.js';

/** globalState key — single record of `{servers, tasks}` arrays. */
const STATE_KEY = 'ssh-fleet.selection.v1';

interface PersistedSelection {
  servers: string[];
  tasks: string[];
}

/**
 * Selection state shared between the TreeView (where users tick
 * checkboxes) and the WebView panel (which reads "what's selected"
 * to display the prompt and dispatch commands).
 *
 * Persisted to `globalState` so re-opening the workspace restores
 * whatever was ticked last. Pruned on config reload — names that no
 * longer match a configured server/task are dropped silently. globalState
 * (vs workspaceState) so selection survives a "Switch Workspace" within
 * the same SSH Fleet workdir context.
 */
export class SelectionState implements vscode.Disposable {
  private readonly _servers = new Set<string>();
  private readonly _tasks = new Set<string>();
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires whenever the server *or* task selection changes. */
  readonly onDidChange = this.emitter.event;

  constructor(private readonly memento?: vscode.Memento) {
    if (memento) {
      const saved = memento.get<PersistedSelection>(STATE_KEY);
      if (saved && Array.isArray(saved.servers) && Array.isArray(saved.tasks)) {
        for (const n of saved.servers) this._servers.add(n);
        for (const n of saved.tasks) this._tasks.add(n);
        log.info(`Selection: hydrated ${this._servers.size} server(s), ${this._tasks.size} task(s) from globalState`);
      } else {
        log.info('Selection: no prior state in globalState (fresh install or first run)');
      }
    } else {
      log.info('Selection: constructed without memento — running in-memory only');
    }
  }

  private save(): void {
    if (!this.memento) return;
    void this.memento.update(STATE_KEY, {
      servers: [...this._servers],
      tasks: [...this._tasks]
    } satisfies PersistedSelection);
    log.info(`Selection: persisted ${this._servers.size} server(s), ${this._tasks.size} task(s) to globalState`);
  }

  private fireChanged(): void {
    this.save();
    this.emitter.fire();
  }

  /** Returns a snapshot copy so callers can't mutate by accident. */
  get servers(): string[] {
    return [...this._servers];
  }

  get tasks(): string[] {
    return [...this._tasks];
  }

  isServerSelected(name: string): boolean {
    return this._servers.has(name);
  }

  isTaskSelected(name: string): boolean {
    return this._tasks.has(name);
  }

  setServer(name: string, selected: boolean): void {
    const had = this._servers.has(name);
    if (selected && !had) {
      this._servers.add(name);
      this.fireChanged();
    } else if (!selected && had) {
      this._servers.delete(name);
      this.fireChanged();
    }
  }

  setTask(name: string, selected: boolean): void {
    const had = this._tasks.has(name);
    if (selected && !had) {
      this._tasks.add(name);
      this.fireChanged();
    } else if (!selected && had) {
      this._tasks.delete(name);
      this.fireChanged();
    }
  }

  /** Bulk replace — emits a single change event. */
  replaceServers(names: Iterable<string>): void {
    this._servers.clear();
    for (const n of names) this._servers.add(n);
    this.emitter.fire();
  }

  replaceTasks(names: Iterable<string>): void {
    this._tasks.clear();
    for (const n of names) this._tasks.add(n);
    this.emitter.fire();
  }

  /**
   * Drop names that no longer correspond to a configured server/task —
   * called after a config reload to keep the selection coherent.
   */
  prune(knownServers: Set<string>, knownTasks: Set<string>): void {
    let changed = false;
    for (const n of [...this._servers]) {
      if (!knownServers.has(n)) {
        this._servers.delete(n);
        changed = true;
      }
    }
    for (const n of [...this._tasks]) {
      if (!knownTasks.has(n)) {
        this._tasks.delete(n);
        changed = true;
      }
    }
    if (changed) this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
