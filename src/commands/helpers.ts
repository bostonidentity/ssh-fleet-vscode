import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as YAML from 'yaml';
import type { CommandContext } from './context.js';

/**
 * Switch the active config — but first confirm + disconnect any active
 * SSH connections from the previous config. Centralises this flow so
 * every entry point (webview panel, command palette, config tree click)
 * gets identical "no orphan connections" behaviour.
 *
 * Why disconnect rather than reuse: same server name in two configs
 * could point to different host/port/user. Persisting the connection
 * across switch would silently route new commands through the OLD
 * host's socket — a near-impossible-to-debug data corruption risk.
 *
 * Returns true when the switch happened, false when the operator
 * cancelled.
 */
export async function confirmAndSwitchActiveConfig(
  ctx: CommandContext,
  targetAbsPath: string
): Promise<boolean> {
  const connected = ctx.registry.connectedCount();
  if (connected > 0) {
    const targetName = path.basename(targetAbsPath);
    const choice = await vscode.window.showWarningMessage(
      `Switch to ${targetName}?`,
      {
        modal: true,
        detail: `${connected} ${connected === 1 ? 'connection' : 'connections'} will disconnect.`
      },
      'Switch'
    );
    if (choice !== 'Switch') return false;
    for (const conn of ctx.registry.list()) {
      ctx.registry.disconnect(conn.server.name);
    }
  }
  await ctx.workspace.setActiveConfig(targetAbsPath);
  await ctx.config.reload();
  return true;
}

/**
 * Enforce `settings.maxServersPerAction` at action-dispatch time. Returns
 * `true` when it's safe to proceed, `false` when the operator must reduce
 * the selection (or raise the cap by editing the config file — there is
 * deliberately no UI escape hatch).
 *
 * The TreeView refuses checkbox ticks past the cap so this dispatch-side
 * check is mostly defensive — it only fires for programmatic selection
 * paths (e.g. `replaceServers` from a special command).
 */
export function enforceServerCap(
  ctx: CommandContext,
  serverCount: number,
  actionLabel: string
): boolean {
  const cap = ctx.config.config.settings.maxServersPerAction;
  if (cap <= 0 || serverCount <= cap) return true;
  void vscode.window.showErrorMessage(
    `SSH Fleet: ${actionLabel} blocked — ${serverCount} servers selected exceeds ` +
    `settings.maxServersPerAction = ${cap}. Untick servers, or raise the cap in your config file.`
  );
  return false;
}

/**
 * Pop a multi-select QuickPick listing every `*.yml` / `*.yaml` file in
 * `<workspace>/tasks/`, with the persisted selection pre-checked. The chosen
 * subset is saved to PrefsStore; ConfigStore reloads to pick up the change.
 * Defaults to nothing selected — operator opts in per file.
 */
export async function cmdSelectTaskFiles(ctx: CommandContext): Promise<void> {
  const dir = ctx.workspace.tasksDir();
  if (!dir) {
    void vscode.window.showWarningMessage('SSH Fleet: workspace not set.');
    return;
  }
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    void vscode.window.showInformationMessage(
      `SSH Fleet: ${dir} doesn't exist yet — drop *.yml task files in there to enable this.`
    );
    return;
  }
  const yamls = entries.filter(n => /\.ya?ml$/i.test(n)).sort();
  if (yamls.length === 0) {
    void vscode.window.showInformationMessage('SSH Fleet: no task files in <workspace>/tasks/.');
    return;
  }
  const selected = new Set(ctx.prefs.selectedTaskFiles);
  const picks = await vscode.window.showQuickPick(
    yamls.map(name => ({ label: name, picked: selected.has(name) })),
    {
      title: 'Select active task files',
      placeHolder: 'Tick the *.yml files whose tasks should appear in the Tasks view',
      canPickMany: true,
      ignoreFocusOut: true
    }
  );
  if (!picks) return;
  await ctx.prefs.setSelectedTaskFiles(picks.map(p => p.label));
}

/**
 * Flip the "auto-deselect all servers after a clean run" preference. Used
 * from the Tasks view overflow menu — VSCode shows two menu entries with
 * mutually-exclusive `when` clauses on the `ssh-fleet.deselectAfterRun`
 * context key, so the visible label always reflects the current state.
 */
export async function cmdToggleDeselectAfterRun(ctx: CommandContext): Promise<void> {
  const next = !ctx.prefs.deselectAfterRun;
  await ctx.prefs.setDeselectAfterRun(next);
  await vscode.commands.executeCommand('setContext', 'ssh-fleet.deselectAfterRun', next);
}

/** Tick every task in the current config + task files. */
export function cmdSelectAllTasks(ctx: CommandContext): void {
  const all = ctx.config.config.tasks.map(t => t.name);
  if (all.length === 0) {
    void vscode.window.showInformationMessage('SSH Fleet: no tasks defined.');
    return;
  }
  ctx.selection.replaceTasks(all);
}

/** Untick every task. */
export function cmdDeselectAllTasks(ctx: CommandContext): void {
  if (ctx.selection.tasks.length === 0) return;
  ctx.selection.replaceTasks([]);
}

/**
 * Copy the host addresses of currently-checked servers to the clipboard.
 * Pure utility — useful for pasting into a one-off ssh / scp / playbook.
 */
export async function cmdCopySelectedHosts(ctx: CommandContext): Promise<void> {
  const selected = ctx.selection.servers;
  if (selected.length === 0) {
    void vscode.window.showInformationMessage('SSH Fleet: tick at least one server first.');
    return;
  }
  const lines: string[] = [];
  for (const name of selected) {
    const s = ctx.config.config.servers.find(x => x.name === name);
    if (s) lines.push(s.host);
  }
  await vscode.env.clipboard.writeText(lines.join('\n'));
  void vscode.window.showInformationMessage(`SSH Fleet: copied ${lines.length} host(s) to clipboard.`);
}

/**
 * Save the currently-checked tasks to a new file in <workdir>/tasks/.
 * Asks the user for a filename; the resulting yaml uses the wrapped form
 * `{ tasks: [...] }` so the loader treats it consistently with config-
 * level task lists.
 */
export async function cmdSaveSelectedTasksAsFile(ctx: CommandContext): Promise<void> {
  const selectedTaskNames = ctx.selection.tasks;
  if (selectedTaskNames.length === 0) {
    void vscode.window.showInformationMessage('SSH Fleet: tick at least one task first.');
    return;
  }
  const tasksDir = ctx.workspace.tasksDir();
  if (!tasksDir) {
    void vscode.window.showWarningMessage('SSH Fleet: workspace not set.');
    return;
  }

  const tasks = selectedTaskNames
    .map(n => ctx.config.config.tasks.find(t => t.name === n))
    .filter((t): t is NonNullable<typeof t> => !!t);
  if (tasks.length === 0) {
    void vscode.window.showWarningMessage('SSH Fleet: selected tasks are no longer in config.');
    return;
  }

  const name = await vscode.window.showInputBox({
    title: 'Save selected tasks as…',
    prompt: 'Filename (will land in <workspace>/tasks/, .yml added if missing)',
    placeHolder: 'maintenance.yml',
    validateInput: v => v.trim() ? null : 'Required'
  });
  if (!name) return;
  const filename = name.trim().endsWith('.yml') || name.trim().endsWith('.yaml')
    ? name.trim()
    : name.trim() + '.yml';
  const target = path.join(tasksDir, filename);

  // Refuse to silently overwrite.
  try {
    await fs.access(target);
    const proceed = await vscode.window.showWarningMessage(
      `${filename} already exists in tasks/. Overwrite?`,
      { modal: true },
      'Overwrite'
    );
    if (proceed !== 'Overwrite') return;
  } catch {
    // missing — proceed
  }

  // Strip in-memory-only fields; preserve user-set ones, drop default-equivalent.
  const yamlTasks = tasks.map(t => {
    const obj: Record<string, unknown> = { name: t.name };
    if (t.type !== 'command') obj.type = t.type;
    if (t.command) obj.command = t.command;
    if (t.src) obj.src = t.src;
    if (t.dest) obj.dest = t.dest;
    if (t.mode) obj.mode = t.mode;
    if (t.args) obj.args = t.args;
    if (t.timeout && t.timeout !== 60) obj.timeout = t.timeout;
    if (t.env && Object.keys(t.env).length) obj.env = t.env;
    if (t.confirmBeforeRun) obj.confirmBeforeRun = t.confirmBeforeRun;
    return obj;
  });

  const doc = new YAML.Document({ tasks: yamlTasks });
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.writeFile(target, doc.toString({ lineWidth: 0 }), 'utf-8');
  await ctx.config.reload();
  void vscode.window.showInformationMessage(
    `SSH Fleet: saved ${tasks.length} task(s) to ${path.relative(ctx.workspace.root ?? '/', target)}`
  );
}
