import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as YAML from 'yaml';
import { z } from 'zod';
import { appConfigSchema, taskFileSchema, type AppConfig, type TaskConfig } from './schema.js';
import { normalizeRawConfig, normalizeTaskFile } from './compat.js';
import { log } from '../util/logger.js';
import type { Workspace } from '../workspace.js';

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map(issue => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `  • ${where}: ${issue.message}`;
    })
    .join('\n');
}

export interface TaskFileLoadError {
  source: string;
  message: string;
}

async function loadTasksFromDir(
  dir: string,
  allowed: Set<string> | undefined
): Promise<{
  tasks: TaskConfig[];
  loadedFrom: string[];
  bySource: Array<{ source: string; task: TaskConfig }>;
  errors: TaskFileLoadError[];
}> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { tasks: [], loadedFrom: [], bySource: [], errors: [] };
    }
    throw err;
  }
  // Empty `allowed` means "no task files active" — operator hasn't picked any
  // yet. `undefined` means "no filter, take all" (used at boot before prefs
  // are wired or for callers that opt out).
  const visible = names
    .filter(n => /\.ya?ml$/i.test(n))
    .filter(n => allowed === undefined || allowed.has(n))
    .sort();
  const yamls = visible;
  const tasks: TaskConfig[] = [];
  const loadedFrom: string[] = [];
  const bySource: Array<{ source: string; task: TaskConfig }> = [];
  const errors: TaskFileLoadError[] = [];
  for (const name of yamls) {
    const full = path.join(dir, name);
    try {
      const text = await fs.readFile(full, 'utf-8');
      const parsed = YAML.parse(text);
      if (parsed === null || parsed === undefined) {
        continue;
      }
      const expanded = deepExpand(parsed);
      const normalized = normalizeTaskFile(expanded);
      const list = taskFileSchema.parse(normalized);
      tasks.push(...list);
      for (const t of list) bySource.push({ source: full, task: t });
      loadedFrom.push(full);
      log.info(`Loaded ${list.length} task(s) from ${full}`);
    } catch (err) {
      // The task silently disappears from the tree if we only log — the
      // operator will spend minutes wondering why their task didn't appear.
      // Capture the error and let the caller surface it.
      const message = err instanceof z.ZodError ? formatZodError(err) : (err as Error).message;
      log.warn(`Failed to load task file ${full}: ${message}`);
      errors.push({ source: full, message });
    }
  }
  return { tasks, loadedFrom, bySource, errors };
}

const VAR_RE = /\$\{(\w+)\}|\$(\w+)/g;

function expandVars(value: string): string {
  return value.replace(VAR_RE, (match, braced, bare) => {
    const name = braced ?? bare;
    return process.env[name] ?? match;
  });
}

function deepExpand(value: unknown): unknown {
  if (typeof value === 'string') {
    return expandVars(value);
  }
  if (Array.isArray(value)) {
    return value.map(deepExpand);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepExpand(v);
    }
    return out;
  }
  return value;
}

async function loadOne(p: string): Promise<unknown> {
  try {
    const text = await fs.readFile(p, 'utf-8');
    const parsed = YAML.parse(text);
    return parsed ?? {};
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new Error(`Failed to read ${p}: ${(err as Error).message}`);
  }
}

export interface LoadResult {
  config: AppConfig;
  loadedFrom: string[];
  /** Map of task-name → absolute path of the file that defined it. Used by
   *  the Tasks tree to group tasks by their source file. */
  taskSources: Record<string, string>;
  /** Per-file errors encountered while loading `tasks/*.yml` — not fatal
   *  (the rest of the config still loads), but the operator needs to see
   *  these or their tasks will silently go missing. */
  taskFileErrors: TaskFileLoadError[];
}

/**
 * Load the active config (single file picked in <workdir>/config/) and
 * layer in any task files from <workdir>/tasks/.
 *
 * Returns an empty AppConfig if no workspace is set or no configs exist —
 * the extension UI handles that empty state with a setup-workspace hint.
 */
export interface LoadOptions {
  selectedTaskFiles?: Set<string>;
  includeActiveConfigTasks?: boolean;
}

export async function loadConfig(
  workspace: Workspace,
  opts: LoadOptions = {}
): Promise<LoadResult> {
  const { selectedTaskFiles, includeActiveConfigTasks = true } = opts;
  if (!workspace.root) {
    return { config: appConfigSchema.parse({}), loadedFrom: [], taskSources: {}, taskFileErrors: [] };
  }

  const loadedFrom: string[] = [];
  const taskSources: Record<string, string> = {};
  const taskFileErrors: TaskFileLoadError[] = [];
  let merged: unknown = {};

  const activeConfig = await workspace.resolveActiveConfig();
  if (activeConfig) {
    const data = await loadOne(activeConfig);
    if (data !== undefined) {
      merged = data;
      loadedFrom.push(activeConfig);
      log.info(`Loaded config from ${activeConfig}`);
    }
  }

  const expanded = deepExpand(merged);
  const normalized = normalizeRawConfig(expanded);
  const parsed = appConfigSchema.parse(normalized);

  // Config-level tasks all originate from the active config file. The user
  // may opt out of loading them via the `includeActiveConfigTasks` pref —
  // useful when they want to drive everything from `tasks/*.yml` files.
  if (!includeActiveConfigTasks) {
    parsed.tasks = [];
  } else if (activeConfig) {
    for (const t of parsed.tasks) {
      taskSources[t.name] = activeConfig;
    }
  }

  // Layer in standalone task files from <workdir>/tasks/. Later sources
  // override earlier ones — both for the task body AND for the source label,
  // since the override is which file actually defines the live behaviour.
  const tasksDir = workspace.tasksDir();
  if (tasksDir) {
    const taskByName = new Map<string, TaskConfig>();
    for (const t of parsed.tasks) {
      taskByName.set(t.name, t);
    }
    const { tasks, loadedFrom: dirSources, bySource, errors } = await loadTasksFromDir(tasksDir, selectedTaskFiles);
    for (const t of tasks) {
      taskByName.set(t.name, t);
    }
    for (const { source, task } of bySource) {
      taskSources[task.name] = source;
    }
    loadedFrom.push(...dirSources);
    taskFileErrors.push(...errors);
    parsed.tasks = [...taskByName.values()];
  }

  return { config: parsed, loadedFrom, taskSources, taskFileErrors };
}

/** Lazy hook — set after PrefsStore is constructed in extension.ts so that the
 *  config loader sees the persisted task-file selection without ConfigStore
 *  needing to import PrefsStore directly. */
export interface TaskFileSelectionProvider {
  selectedTaskFiles(): string[];
  includeActiveConfigTasks(): boolean;
}

export class ConfigStore implements vscode.Disposable {
  private current: AppConfig = appConfigSchema.parse({});
  private loadedFrom: string[] = [];
  private currentTaskSources: Record<string, string> = {};
  private watchers: vscode.FileSystemWatcher[] = [];
  private readonly emitter = new vscode.EventEmitter<AppConfig>();
  readonly onDidChange = this.emitter.event;
  private taskSelection: TaskFileSelectionProvider | undefined;

  constructor(private readonly workspace: Workspace) {
    this.workspace.onDidChange(() => { void this.reload(); });
  }

  /** Wire in the persisted task-file selection — extension.ts calls this
   *  after PrefsStore is created. */
  bindTaskFileSelection(provider: TaskFileSelectionProvider): void {
    this.taskSelection = provider;
  }

  get config(): AppConfig {
    return this.current;
  }

  get sources(): string[] {
    return [...this.loadedFrom];
  }

  /** Map task-name → absolute path of the file that defined it (config or
   *  `<workspace>/tasks/*.yml`). Read by the Tasks tree to group rows. */
  get taskSources(): Record<string, string> {
    return this.currentTaskSources;
  }

  /**
   * Reload the active config + standalone task files. Returns true on
   * success, false when the load failed (an error modal is shown
   * internally in that case). Callers that drive a "config reloaded"
   * toast should suppress it on false to avoid stacking conflicting
   * messages on top of the error modal.
   */
  async reload(): Promise<boolean> {
    try {
      const allowed = this.taskSelection
        ? new Set(this.taskSelection.selectedTaskFiles())
        : undefined;
      const includeActiveConfigTasks = this.taskSelection
        ? this.taskSelection.includeActiveConfigTasks()
        : true;
      const { config, loadedFrom, taskSources, taskFileErrors } = await loadConfig(this.workspace, {
        selectedTaskFiles: allowed,
        includeActiveConfigTasks
      });
      this.current = config;
      this.loadedFrom = loadedFrom;
      this.currentTaskSources = taskSources;
      this.attachWatchers(loadedFrom);
      this.emitter.fire(config);
      // Surface per-file load errors as a non-modal toast — without this the
      // task silently disappears from the tree and the operator has nothing
      // to debug from.
      if (taskFileErrors.length > 0) {
        const summary = taskFileErrors.length === 1
          ? `Task file failed to load: ${path.basename(taskFileErrors[0].source)}`
          : `${taskFileErrors.length} task files failed to load`;
        const detail = taskFileErrors
          .map(e => `${path.basename(e.source)}: ${e.message}`)
          .join('\n');
        void vscode.window.showWarningMessage(
          `SSH Fleet: ${summary}`,
          { detail } as vscode.MessageOptions,
          'View Details'
        ).then(action => {
          if (action === 'View Details') {
            log.warn(`Task file load errors:\n${detail}`);
            void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
          }
        });
      }
      return true;
    } catch (err) {
      log.error('Config reload failed', err);
      const isZod = err instanceof z.ZodError;
      const summary = isZod
        ? `Config validation failed:\n${formatZodError(err)}`
        : `Failed to load config: ${(err as Error).message}`;
      const action = await vscode.window.showErrorMessage(
        `SSH Fleet: ${isZod ? 'config has invalid fields' : 'config load failed'}`,
        { detail: summary, modal: false } as vscode.MessageOptions,
        'Open Config',
        'View Details'
      );
      if (action === 'Open Config') {
        void vscode.commands.executeCommand('ssh-fleet.openConfig');
      } else if (action === 'View Details') {
        log.error(summary);
        void vscode.commands.executeCommand('workbench.action.output.toggleOutput');
      }
      return false;
    }
  }

  private attachWatchers(paths: string[]): void {
    for (const w of this.watchers) {
      w.dispose();
    }
    this.watchers = [];
    const handler = (): void => { void this.reload(); };

    for (const p of paths) {
      const w = vscode.workspace.createFileSystemWatcher(p);
      w.onDidChange(handler);
      w.onDidCreate(handler);
      w.onDidDelete(handler);
      this.watchers.push(w);
    }

    // Watch the workspace's config/ and tasks/ dirs so adding a brand-new
    // YAML there triggers reload (per-file watchers above only catch edits
    // and deletes of files that were already loaded).
    const configDir = this.workspace.configDir();
    if (configDir) {
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(configDir, '*.{yml,yaml}')
      );
      w.onDidChange(handler);
      w.onDidCreate(handler);
      w.onDidDelete(handler);
      this.watchers.push(w);

      // .last_config pointer file too — switching active config should reload.
      const wLast = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(configDir, '.last_config')
      );
      wLast.onDidChange(handler);
      wLast.onDidCreate(handler);
      this.watchers.push(wLast);
    }
    const tasksDir = this.workspace.tasksDir();
    if (tasksDir) {
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(tasksDir, '*.{yml,yaml}')
      );
      w.onDidChange(handler);
      w.onDidCreate(handler);
      w.onDidDelete(handler);
      this.watchers.push(w);
    }
  }

  dispose(): void {
    for (const w of this.watchers) {
      w.dispose();
    }
    this.emitter.dispose();
  }
}
