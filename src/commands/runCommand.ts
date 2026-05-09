import * as vscode from 'vscode';
import type { CommandContext } from './context.js';
import { pickServer, pickServers } from './serverPicker.js';
import { broadcastCommand } from '../features/broadcast.js';
import { runTaskOnServers } from '../features/taskRunner.js';
import { detectInteractive, detectShellBuiltinPitfall, detectStdinBlocking } from '../features/safety.js';
import { enforceServerCap } from './helpers.js';
import { SshFleetWebviewPanel } from '../webview/panel.js';

const DEFAULT_TIMEOUT_KEY = 'ssh-fleet.defaultTimeout';

function timeoutMs(): number {
  const sec = vscode.workspace.getConfiguration().get<number>(DEFAULT_TIMEOUT_KEY) ?? 60;
  return sec > 0 ? sec * 1000 : 0;
}

/** Ensure the Console is open before a run dispatches. The output is
 *  meaningless if the operator can't see it — and they explicitly asked
 *  for output by clicking Run. preserveFocus=true so we don't yank focus
 *  out of whatever they're editing. */
function showConsole(ctx: CommandContext): void {
  SshFleetWebviewPanel.showOrCreate(ctx, true);
}

/** Surface a non-blocking hint when the command is a shell builtin that
 *  produces empty/useless output over non-interactive SSH (`history`,
 *  `alias`, etc.). Doesn't block — the operator might be running it
 *  deliberately to confirm the empty state. The hint goes inline into
 *  the output panel near the cmd-block, where they'll look. */
function noteShellBuiltinPitfall(ctx: CommandContext, command: string): void {
  const hint = detectShellBuiltinPitfall(command);
  if (hint) ctx.output.warn(hint.hint);
}

/** Block dispatch when the command would read stdin we never send —
 *  these hang the SSH session for the entire task timeout (60s default)
 *  for nothing. Returns true if the operator cancelled (caller should
 *  short-circuit), false if the command is safe to run.
 */
async function blockIfStdinBlocking(command: string): Promise<boolean> {
  const blocker = detectStdinBlocking(command);
  if (!blocker) return false;
  const proceed = await vscode.window.showWarningMessage(
    `'${blocker.name}' will hang the SSH session waiting for stdin.`,
    { modal: true, detail: blocker.hint },
    'Run Anyway'
  );
  return proceed !== 'Run Anyway';
}

/** Pull a task name out of whatever `cmdRunTaskByName` was invoked with —
 *  programmatic `{ taskName }`, a TreeView `TaskNode` (`{ task: { name } }`),
 *  or just a string. Returns undefined on no match (caller falls back to
 *  the multi-task picker). */
function extractTaskNameForRun(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object') {
    const a = arg as { taskName?: string; task?: { name?: string }; name?: string };
    return a.taskName ?? a.task?.name ?? a.name;
  }
  return undefined;
}

/** Single-server one-shot command — useful for "run X without opening terminal". */
export async function cmdRunCommand(ctx: CommandContext, arg: unknown): Promise<void> {
  const server = await pickServer(ctx.config.config, arg, 'Run command on server');
  if (!server) {
    return;
  }
  const command = await promptCommand(ctx, server.name);
  if (!command) {
    return;
  }
  const interactive = detectInteractive(command);
  if (interactive) {
    void vscode.window.showWarningMessage(
      `'${interactive}' needs an interactive terminal — use Open Terminal instead.`
    );
    return;
  }
  if (await blockIfStdinBlocking(command)) return;
  showConsole(ctx);
  noteShellBuiltinPitfall(ctx, command);
  await broadcastCommand({
    servers: [server],
    command,
    config: ctx.config.config,
    registry: ctx.registry,
    output: ctx.output,
    history: ctx.history,
    timeoutMs: timeoutMs()
  });
}

/**
 * Multi-server fan-out. Uses the TreeView's current selection if non-empty;
 * only falls back to a picker when nothing is checked.
 */
export async function cmdRunOnGroup(ctx: CommandContext): Promise<void> {
  let servers;
  const selected = ctx.selection.servers;
  if (selected.length > 0) {
    servers = selected
      .map(n => ctx.config.config.servers.find(s => s.name === n))
      .filter((s): s is NonNullable<typeof s> => !!s);
  } else {
    servers = await pickServers(ctx.config.config, 'Pick servers to run on');
  }
  if (servers.length === 0) {
    return;
  }
  if (!enforceServerCap(ctx, servers.length, 'Broadcast')) return;
  const command = await promptCommand(ctx, '@broadcast');
  if (!command) {
    return;
  }
  const interactive = detectInteractive(command);
  if (interactive) {
    void vscode.window.showWarningMessage(
      `'${interactive}' needs an interactive terminal — broadcast won't work for that.`
    );
    return;
  }
  if (await blockIfStdinBlocking(command)) return;
  showConsole(ctx);
  noteShellBuiltinPitfall(ctx, command);
  await broadcastCommand({
    servers,
    command,
    config: ctx.config.config,
    registry: ctx.registry,
    output: ctx.output,
    history: ctx.history,
    timeoutMs: timeoutMs()
  });
}

/**
 * Run a task on the servers currently checked in the TreeView.
 * No second picker — selection is the source of truth.
 *
 * Arg shapes accepted:
 *   - `{ taskName: string }` — programmatic call (e.g. webview `:run xxx`)
 *   - `TaskNode` from a tree right-click — `{ kind: 'task', task: { name } }`
 *   - `undefined` — falls through to `cmdRunTask` (run ticked tasks).
 */
export async function cmdRunTaskByName(ctx: CommandContext, arg: unknown): Promise<void> {
  const taskName = extractTaskNameForRun(arg);
  if (!taskName) {
    return cmdRunTask(ctx);
  }
  const task = ctx.config.config.tasks.find(t => t.name === taskName);
  if (!task) {
    void vscode.window.showErrorMessage(`SSH Fleet: task '${taskName}' not found`);
    return;
  }
  const selectedNames = ctx.selection.servers;
  const servers = selectedNames
    .map(n => ctx.config.config.servers.find(s => s.name === n))
    .filter((s): s is NonNullable<typeof s> => !!s);
  if (servers.length === 0) {
    void vscode.window.showWarningMessage(
      `SSH Fleet: tick at least one server in the sidebar before running '${task.name}'.`
    );
    return;
  }
  if (!enforceServerCap(ctx, servers.length, `Run task '${task.name}'`)) return;
  if (task.confirmBeforeRun) {
    const summary = task.type === 'command' ? task.command
      : task.type === 'upload' ? `upload ${task.src} -> ${task.dest}`
      : `script ${task.src}${task.args ? ' ' + task.args : ''}`;
    const proceed = await vscode.window.showWarningMessage(
      `Run '${task.name}' on ${servers.length} server(s)?\n\n${summary}`,
      { modal: true }, 'Run'
    );
    if (proceed !== 'Run') {
      return;
    }
  }
  showConsole(ctx);
  await runTaskOnServers({
    task,
    servers,
    config: ctx.config.config,
    registry: ctx.registry,
    output: ctx.output,
    history: ctx.history,
    defaultTimeoutMs: timeoutMs(),
    ...(ctx.workspace.root ? { workspaceRoot: ctx.workspace.root } : {})
  });
  // Auto-deselect the just-run *task* (not the servers!) so re-clicking
  // Run Selected Tasks doesn't silently re-execute the same task.
  if (ctx.prefs.deselectAfterRun) {
    ctx.selection.setTask(task.name, false);
  }
}

/**
 * Run the *ticked* tasks on the *ticked* servers. No popup fallback — if
 * neither set is ticked the operator gets a clear warning telling them what
 * to tick. Selection in the TreeView is the single source of truth.
 */
export async function cmdRunTask(ctx: CommandContext): Promise<void> {
  const allTasks = ctx.config.config.tasks;
  if (allTasks.length === 0) {
    void vscode.window.showInformationMessage('SSH Fleet: no tasks defined in config.');
    return;
  }

  const tickedTaskNames = ctx.selection.tasks;
  if (tickedTaskNames.length === 0) {
    void vscode.window.showWarningMessage(
      'SSH Fleet: tick at least one task in the Tasks view first.'
    );
    return;
  }
  const tasksToRun = tickedTaskNames
    .map(n => allTasks.find(t => t.name === n))
    .filter((t): t is NonNullable<typeof t> => !!t);

  const tickedServerNames = ctx.selection.servers;
  if (tickedServerNames.length === 0) {
    void vscode.window.showWarningMessage(
      'SSH Fleet: tick at least one server in the Servers view first.'
    );
    return;
  }
  const servers = tickedServerNames
    .map(n => ctx.config.config.servers.find(s => s.name === n))
    .filter((s): s is NonNullable<typeof s> => !!s);
  if (servers.length === 0) {
    return;
  }
  if (!enforceServerCap(ctx, servers.length, 'Run Selected Tasks')) return;

  showConsole(ctx);
  // Run each selected task in sequence.
  for (const task of tasksToRun) {
    if (task.confirmBeforeRun) {
      const summary = task.type === 'command' ? task.command
        : task.type === 'upload' ? `upload ${task.src} -> ${task.dest}`
        : `script ${task.src}${task.args ? ' ' + task.args : ''}`;
      const proceed = await vscode.window.showWarningMessage(
        `Run '${task.name}' on ${servers.length} server(s)?\n\n${summary}`,
        { modal: true }, 'Run'
      );
      if (proceed !== 'Run') {
        continue;
      }
    }
    await runTaskOnServers({
      task,
      servers,
      config: ctx.config.config,
      registry: ctx.registry,
      output: ctx.output,
      history: ctx.history,
      defaultTimeoutMs: timeoutMs(),
      ...(ctx.workspace.root ? { workspaceRoot: ctx.workspace.root } : {})
    });
    // Auto-deselect the *task* (not the servers) so a follow-up Run Selected
    // Tasks doesn't silently re-execute what just finished. Servers stay
    // ticked because the operator typically runs multiple tasks against the
    // same target set.
    if (ctx.prefs.deselectAfterRun) {
      ctx.selection.setTask(task.name, false);
    }
  }
}

async function promptCommand(ctx: CommandContext, scope: string): Promise<string | undefined> {
  const recent = ctx.history.list(scope).slice(0, 10).map(e => e.command);
  const fresh = await vscode.window.showInputBox({
    prompt: `Command to run on ${scope}`,
    placeHolder: recent[0] ?? 'e.g. uptime',
    ignoreFocusOut: true
  });
  return fresh?.trim() || undefined;
}

export async function cmdRunFromHistory(ctx: CommandContext): Promise<void> {
  const allKeys = new Set<string>(['@broadcast', ...ctx.config.config.servers.map(s => s.name)]);
  const allEntries: { server: string; command: string; ts: number }[] = [];
  for (const k of allKeys) {
    for (const e of ctx.history.list(k)) {
      allEntries.push({ server: k, command: e.command, ts: e.ts });
    }
  }
  if (allEntries.length === 0) {
    void vscode.window.showInformationMessage('SSH Fleet: history is empty.');
    return;
  }
  allEntries.sort((a, b) => b.ts - a.ts);
  const pick = await vscode.window.showQuickPick(
    allEntries.map(e => ({
      label: e.command,
      description: e.server,
      detail: new Date(e.ts).toLocaleString(),
      entry: e
    })),
    { title: 'Run from history', matchOnDescription: true }
  );
  if (!pick) {
    return;
  }
  const targetName = pick.entry.server === '@broadcast'
    ? undefined
    : pick.entry.server;
  if (targetName) {
    const server = ctx.config.config.servers.find(s => s.name === targetName);
    if (!server) {
      return;
    }
    if (await blockIfStdinBlocking(pick.entry.command)) return;
    showConsole(ctx);
    noteShellBuiltinPitfall(ctx, pick.entry.command);
    await broadcastCommand({
      servers: [server],
      command: pick.entry.command,
      config: ctx.config.config,
      registry: ctx.registry,
      output: ctx.output,
      history: ctx.history,
      timeoutMs: timeoutMs()
    });
  } else {
    const servers = await pickServers(ctx.config.config, 'Re-broadcast to which servers?');
    if (servers.length === 0) {
      return;
    }
    if (await blockIfStdinBlocking(pick.entry.command)) return;
    showConsole(ctx);
    noteShellBuiltinPitfall(ctx, pick.entry.command);
    await broadcastCommand({
      servers,
      command: pick.entry.command,
      config: ctx.config.config,
      registry: ctx.registry,
      output: ctx.output,
      history: ctx.history,
      timeoutMs: timeoutMs()
    });
  }
}
