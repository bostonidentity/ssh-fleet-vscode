import * as vscode from 'vscode';

const KEY = 'ssh-fleet.prefs.v1';

interface PrefsPayload {
  hideTimestamps?: boolean;
  deselectAfterRun?: boolean;
  /** Names of task-files (basenames under <workspace>/tasks/) currently active. */
  selectedTaskFiles?: string[];
  /** Whether tasks defined inside the active config file load. Default true. */
  includeActiveConfigTasks?: boolean;
}

/**
 * User-level UI preferences that persist across sessions in globalState.
 * Distinct from `ssh-fleet.workspaceDir` (a single setting) and from session
 * state like SelectionState — these are toggles the user wants remembered.
 */
export class PrefsStore implements vscode.Disposable {
  private cache: PrefsPayload;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {
    this.cache = state.get<PrefsPayload>(KEY) ?? {};
  }

  get hideTimestamps(): boolean {
    return this.cache.hideTimestamps ?? false;
  }
  get deselectAfterRun(): boolean {
    return this.cache.deselectAfterRun ?? false;
  }
  /** Empty array means "no task files" — i.e. only config-level tasks load. */
  get selectedTaskFiles(): string[] {
    return this.cache.selectedTaskFiles ?? [];
  }
  /** Whether the active config file's `tasks:` block contributes tasks. */
  get includeActiveConfigTasks(): boolean {
    return this.cache.includeActiveConfigTasks ?? true;
  }

  async setHideTimestamps(v: boolean): Promise<void> {
    if (this.cache.hideTimestamps === v) return;
    this.cache.hideTimestamps = v;
    await this.persist();
  }
  async setDeselectAfterRun(v: boolean): Promise<void> {
    if (this.cache.deselectAfterRun === v) return;
    this.cache.deselectAfterRun = v;
    await this.persist();
  }
  async setSelectedTaskFiles(files: string[]): Promise<void> {
    const next = [...new Set(files)].sort();
    const cur = this.selectedTaskFiles;
    if (cur.length === next.length && cur.every((v, i) => v === next[i])) return;
    this.cache.selectedTaskFiles = next;
    await this.persist();
  }
  async setIncludeActiveConfigTasks(v: boolean): Promise<void> {
    if (this.includeActiveConfigTasks === v) return;
    this.cache.includeActiveConfigTasks = v;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.state.update(KEY, this.cache);
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
