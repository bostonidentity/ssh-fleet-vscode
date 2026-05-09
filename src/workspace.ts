import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { log } from './util/logger.js';

const SETTING_KEY = 'ssh-fleet.workspaceDir';
const LAST_CONFIG_FILE = '.last_config';

/**
 * Snapshot of the user's chosen working directory and the paths derived from it.
 *
 * Layout — convention-over-configuration; legacy config layouts using the
 * same shape can be dropped in unchanged:
 *
 *   <root>/
 *     config/<*.yml>          ← one or more configs; one is "active"
 *     config/.last_config     ← plain-text basename of the active config
 *     tasks/<*.yml>           ← shared task library
 *     mirror/<server>/<path>  ← downloaded remote files
 *     known_hosts.json        ← TOFU trust store
 */
export class Workspace {
  private _root: string | undefined;
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  /** Fires when the active workspace path changes (including initial set). */
  readonly onDidChange = this.emitter.event;

  constructor(readonly extensionUri?: vscode.Uri) {
    this._root = readWorkspaceSetting();
  }

  /** Absolute path to the workspace root, or undefined if not picked yet. */
  get root(): string | undefined {
    return this._root;
  }

  configDir(): string | undefined {
    return this._root ? path.join(this._root, 'config') : undefined;
  }

  tasksDir(): string | undefined {
    return this._root ? path.join(this._root, 'tasks') : undefined;
  }

  mirrorDir(): string | undefined {
    return this._root ? path.join(this._root, 'mirror') : undefined;
  }

  knownHostsPath(): string | undefined {
    return this._root ? path.join(this._root, 'known_hosts.json') : undefined;
  }

  /** Read .last_config to find the active config; fall back to default.yml or first *.yml. */
  async resolveActiveConfig(): Promise<string | undefined> {
    const dir = this.configDir();
    if (!dir) {
      return undefined;
    }
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return undefined;
    }
    const yamls = entries.filter(n => /\.ya?ml$/i.test(n)).sort();
    if (yamls.length === 0) {
      return undefined;
    }
    // 1. .last_config pointer file (operator-set)
    try {
      const last = (await fs.readFile(path.join(dir, LAST_CONFIG_FILE), 'utf-8')).trim();
      if (last && yamls.includes(last)) {
        return path.join(dir, last);
      }
    } catch {
      // missing/invalid pointer — fall through
    }
    // 2. default.yml convention
    if (yamls.includes('default.yml')) {
      return path.join(dir, 'default.yml');
    }
    if (yamls.includes('default.yaml')) {
      return path.join(dir, 'default.yaml');
    }
    // 3. first alphabetically
    return path.join(dir, yamls[0]);
  }

  async setActiveConfig(absConfigPath: string): Promise<void> {
    const dir = this.configDir();
    if (!dir) {
      return;
    }
    const base = path.basename(absConfigPath);
    await fs.writeFile(path.join(dir, LAST_CONFIG_FILE), base + '\n', 'utf-8');
  }

  async listConfigs(): Promise<string[]> {
    const dir = this.configDir();
    if (!dir) {
      return [];
    }
    try {
      const entries = await fs.readdir(dir);
      return entries.filter(n => /\.ya?ml$/i.test(n)).sort();
    } catch {
      return [];
    }
  }

  /** Make sure the standard subdirectories exist under the root. */
  async ensureLayout(): Promise<void> {
    if (!this._root) {
      return;
    }
    await fs.mkdir(this._root, { recursive: true });
    for (const sub of ['config', 'tasks', 'mirror']) {
      await fs.mkdir(path.join(this._root, sub), { recursive: true });
    }
  }

  /** Switch to a new root. Persists in user settings; fires change event. */
  async setRoot(absPath: string): Promise<void> {
    const expanded = expandHome(absPath);
    await vscode.workspace.getConfiguration().update(
      SETTING_KEY,
      expanded,
      vscode.ConfigurationTarget.Global
    );
    this._root = expanded;
    await this.ensureLayout();
    log.info(`Workspace root set to ${expanded}`);
    this.emitter.fire(expanded);
  }

  /** First-run interactive picker. Returns the picked root, or undefined if cancelled. */
  async runFirstRunWizard(): Promise<string | undefined> {
    const home = os.homedir();
    const dotssh = path.join(home, '.ssh-fleet');
    const suggestedNew = path.join(home, 'SSH Fleet');

    let dotsshHasContent = false;
    try {
      const entries = await fs.readdir(dotssh);
      // Only count loadable YAMLs — .bak / .salt / etc shouldn't trigger
      // the "reuse" option since they aren't valid configs.
      dotsshHasContent = entries.some(n => /\.ya?ml$/i.test(n));
      // Also recognise the new layout (config/ subdir with yml in it).
      if (!dotsshHasContent) {
        try {
          const sub = await fs.readdir(path.join(dotssh, 'config'));
          dotsshHasContent = sub.some(n => /\.ya?ml$/i.test(n));
        } catch {
          // no config/ subdir — fine
        }
      }
    } catch {
      // doesn't exist — no signal
    }

    type Option = { label: string; description?: string; detail?: string; action: 'pick' | 'create' | 'reuse' };
    const options: Option[] = [
      {
        label: '$(folder-opened) Pick existing folder…',
        description: 'use a directory you already have',
        action: 'pick'
      },
      {
        label: `$(new-folder) Create new folder (${suggestedNew})`,
        description: 'fresh start; copy old configs in afterwards',
        action: 'create'
      }
    ];
    if (dotsshHasContent) {
      options.unshift({
        label: `$(history) Reuse ~/.ssh-fleet as workspace`,
        description: 'detected existing config there',
        detail: dotssh,
        action: 'reuse'
      });
    }

    const pick = await vscode.window.showQuickPick(options, {
      title: 'SSH Fleet — set up working directory',
      placeHolder: 'Where should configs, downloaded files, and task library live?',
      ignoreFocusOut: true
    });
    if (!pick) {
      return undefined;
    }

    let chosen: string | undefined;
    if (pick.action === 'reuse') {
      chosen = dotssh;
    } else if (pick.action === 'create') {
      const inputName = await vscode.window.showInputBox({
        title: 'New workspace path',
        value: suggestedNew,
        prompt: 'Absolute path or ~/-prefixed; will be created if missing',
        ignoreFocusOut: true
      });
      if (!inputName) {
        return undefined;
      }
      chosen = expandHome(inputName);
    } else {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Use as workspace',
        title: 'Pick the SSH Fleet working directory'
      });
      if (!picked || picked.length === 0) {
        return undefined;
      }
      chosen = picked[0].fsPath;
    }

    if (!chosen) {
      return undefined;
    }

    await this.setRoot(chosen);

    // If the freshly-set workspace has no configs, scaffold the starter
    // files so the user has something to read / edit immediately.
    const configs = await this.listConfigs();
    if (configs.length === 0) {
      await this.scaffoldStarterFiles();
    }

    return chosen;
  }

  /**
   * Copy the bundled starter YAMLs (config + standalone task file) into
   * the freshly-created workspace. The source files live in the
   * extension's `resources/starter/` directory and are copied verbatim
   * — comments, formatting, everything — so the user sees the same
   * annotated YAML the maintainers shipped.
   */
  private async scaffoldStarterFiles(): Promise<void> {
    if (!this.extensionUri) {
      log.warn('scaffold skipped: extensionUri unavailable');
      return;
    }
    const sources = [
      { from: 'default.yml', to: path.join(this.configDir()!, 'default.yml') },
      { from: 'examples-tasks.yml', to: path.join(this.tasksDir()!, 'examples.yml') }
    ];
    for (const s of sources) {
      try {
        await fs.access(s.to);
        // Already exists — never clobber a file the operator may have
        // started editing.
      } catch {
        const src = vscode.Uri.joinPath(this.extensionUri, 'resources', 'starter', s.from);
        try {
          const data = await fs.readFile(src.fsPath);
          await fs.mkdir(path.dirname(s.to), { recursive: true });
          await fs.writeFile(s.to, data);
        } catch (err) {
          log.warn(`Failed to scaffold ${s.to}: ${(err as Error).message}`);
        }
      }
    }
  }
}

function readWorkspaceSetting(): string | undefined {
  const raw = vscode.workspace.getConfiguration().get<string>(SETTING_KEY);
  if (!raw || raw.trim() === '') {
    return undefined;
  }
  return expandHome(raw);
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  if (p === '~') {
    return os.homedir();
  }
  return p;
}

