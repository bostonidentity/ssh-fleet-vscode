import * as path from 'node:path';
import * as vscode from 'vscode';
import { initLogger, log } from './util/logger.js';
import { Workspace } from './workspace.js';
import { ConfigStore } from './config/loader.js';
import { SecretStore } from './secrets/store.js';
import { ConnectionRegistry } from './ssh/connection.js';
import { HostKeyStore } from './ssh/hostKeys.js';
import { OutputManager } from './output/channel.js';
import { CommandHistory } from './features/history.js';
import { BookmarkStore } from './features/bookmarks.js';
import { MirrorStore } from './features/mirror.js';
import { SelectionState } from './state/selection.js';
import { VirtualCwdState } from './state/cwd.js';
import { ScheduleStore, type ScheduledTask } from './state/schedule.js';
import { ServerFilterState } from './state/serverFilter.js';
import { PrefsStore } from './state/prefs.js';
import { BackupHealthState } from './state/backupHealth.js';
import { KeepAwake } from './state/keepAwake.js';
import { WorkdirStateStore } from './state/workdirState.js';
import { ConnectionHistoryStore } from './state/connectionHistory.js';
import { ServerTreeProvider } from './views/serverTreeProvider.js';
import { TaskTreeProvider } from './views/taskTreeProvider.js';
import { ConfigsTreeProvider } from './views/configsTreeProvider.js';
import { StatusBar } from './views/statusBar.js';
import { MirrorStatusBar } from './views/mirrorStatusBar.js';
import { MountStatusBar } from './views/mountStatusBar.js';
import { SshFileSystemProvider, SCHEME as SSH_SCHEME } from './views/sshFileSystemProvider.js';
import { SshFleetWebviewPanel } from './webview/panel.js';
import { registerCommands } from './commands/index.js';
import { registerSiblingTracker } from './commands/multiEdit.js';
import type { CommandContext } from './commands/context.js';
import type { TreeNode } from './views/serverTreeItem.js';

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  initLogger(ctx);
  log.info('Activating SSH Fleet extension');

  const workspace = new Workspace(ctx.extensionUri);
  if (!workspace.root) {
    await workspace.runFirstRunWizard();
  } else {
    await workspace.ensureLayout();
  }

  const secrets = new SecretStore(ctx.secrets);
  const hostKeys = new HostKeyStore(ctx, workspace);

  // File-backed state store — writes to `<workdir>/.ssh-fleet-state.json`.
  // Constructed early so it's available to PrefsStore, ScheduleStore,
  // BookmarkStore, and CommandHistory (all of which migrated from
  // globalState to this in 0.2.3). Lives with the workdir on whatever
  // storage the operator chose, so state survives a user-profile reset.
  const workdirState = new WorkdirStateStore(workspace, ctx.globalState);
  await workdirState.hydrateAsync();
  ctx.subscriptions.push(workspace.onDidChange(() => void workdirState.onWorkspaceRootChanged()));

  // PrefsStore is constructed early so ConfigStore can read the persisted
  // task-file selection on its first load (default empty = no task files).
  const prefs = new PrefsStore(workdirState);
  ctx.subscriptions.push(prefs);
  // Mirror the deselect-after-run pref into a context key so the Tasks
  // overflow menu can swap "Enable / Disable" labels via `when` clauses.
  void vscode.commands.executeCommand(
    'setContext', 'ssh-fleet.deselectAfterRun', prefs.deselectAfterRun
  );

  const config = new ConfigStore(workspace);
  config.bindTaskFileSelection({
    selectedTaskFiles: () => prefs.selectedTaskFiles,
    includeActiveConfigTasks: () => prefs.includeActiveConfigTasks
  });
  ctx.subscriptions.push(config);
  await config.reload();

  const keepaliveSeconds = vscode.workspace.getConfiguration().get<number>('ssh-fleet.keepaliveInterval')
    ?? config.config.settings.keepaliveSeconds
    ?? 30;
  const registry = new ConnectionRegistry(secrets, hostKeys, { keepaliveSeconds });
  ctx.subscriptions.push(registry);

  const output = new OutputManager();
  ctx.subscriptions.push(output);
  // Drives the OutputManager's flush ordering. Multi-server stream
  // chunks arrive in ssh2-arrival order (network timing); we drain them
  // in CONFIG order so output reads the same as the Servers tree
  // top-to-bottom. Re-synced on every config reload so adding/removing
  // a server flows straight through.
  output.setServerOrder(config.config.servers.map(s => s.name));
  ctx.subscriptions.push(config.onDidChange(c =>
    output.setServerOrder(c.servers.map(s => s.name))
  ));

  const history = new CommandHistory(workdirState);
  const bookmarks = new BookmarkStore(workdirState);
  const mirror = new MirrorStore(ctx, registry, config, workspace);
  ctx.subscriptions.push(mirror);

  // Shared session-scoped state — selection (which servers/tasks are ticked)
  // and virtual cwd (per-server logical pwd that broadcast prepends with).
  const selection = new SelectionState(workdirState);
  ctx.subscriptions.push(selection);
  const cwd = new VirtualCwdState(registry, ctx.globalState);
  ctx.subscriptions.push(cwd);
  const schedule = new ScheduleStore(workdirState);
  ctx.subscriptions.push(schedule);
  // Filter state is keyed by active config name — switching between
  // configs swaps in/out the saved filter for each. The getter is
  // re-evaluated on every config reload via onActiveConfigChanged().
  const activeConfigName = (): string | undefined => {
    const first = config.sources[0];
    return first ? path.basename(first) : undefined;
  };
  const serverFilter = new ServerFilterState(workdirState, activeConfigName);
  ctx.subscriptions.push(config.onDidChange(() => serverFilter.onActiveConfigChanged()));
  ctx.subscriptions.push(serverFilter);
  // Tracks the last `connected` timestamp for each server name. Records
  // on every state transition to `connected` (initial connect + reconnect
  // both stamp fresh). Surfaces in the ServerNode tooltip and powers the
  // "Recent Connections" filter row.
  const connectionHistory = new ConnectionHistoryStore(workdirState);
  ctx.subscriptions.push(connectionHistory);
  ctx.subscriptions.push(registry.onChange(name => {
    if (registry.get(name)?.state === 'connected') {
      connectionHistory.record(name);
    }
  }));
  // Drop entries for servers no longer in the config after reload.
  ctx.subscriptions.push(config.onDidChange(c =>
    connectionHistory.prune(new Set(c.servers.map(s => s.name)))
  ));
  // Probe `backupDir` writability on each connect; the panel turns the
  // 🛡 backup badge gray if any selected server's probe fails. Without
  // this, the operator sees "backup is on" right up until their first rm
  // dies on a Permission denied at 3am.
  const backupHealth = new BackupHealthState(registry, config);
  ctx.subscriptions.push(backupHealth);
  // (PrefsStore is created near the top so ConfigStore can read task-file
  //  selection on its first load.)
  let lastDeselect = prefs.deselectAfterRun;
  let lastTaskFilesKey = prefs.selectedTaskFiles.join('|');
  let lastIncludeConfigTasks = prefs.includeActiveConfigTasks;
  ctx.subscriptions.push(prefs.onDidChange(() => {
    if (prefs.deselectAfterRun !== lastDeselect) {
      lastDeselect = prefs.deselectAfterRun;
      void vscode.commands.executeCommand(
        'setContext', 'ssh-fleet.deselectAfterRun', prefs.deselectAfterRun
      );
    }
    const key = prefs.selectedTaskFiles.join('|');
    if (key !== lastTaskFilesKey || prefs.includeActiveConfigTasks !== lastIncludeConfigTasks) {
      lastTaskFilesKey = key;
      lastIncludeConfigTasks = prefs.includeActiveConfigTasks;
      void config.reload();
    }
  }));

  // Track cwd state across connection lifecycle: probe `pwd` on connect so
  // the breadcrumb shows the real starting directory, and reset state when
  // the connection drops.
  ctx.subscriptions.push(registry.onChange(name => {
    const conn = registry.get(name);
    if (!conn || conn.state === 'idle' || conn.state === 'error') {
      cwd.resetServer(name);
    } else if (conn.state === 'connected') {
      cwd.initFromConnection(conn).catch(() => { /* logged inside */ });
    }
  }));

  const serverTreeProvider = new ServerTreeProvider(
    config.config, registry, config.onDidChange, selection, ctx.extensionUri, serverFilter,
    connectionHistory
  );
  ctx.subscriptions.push(serverTreeProvider);
  const serverTreeView = vscode.window.createTreeView<TreeNode>('ssh-fleet.servers', {
    treeDataProvider: serverTreeProvider,
    manageCheckboxStateManually: true
  });
  ctx.subscriptions.push(serverTreeView);
  ctx.subscriptions.push(serverTreeProvider.bindCheckbox(serverTreeView));

  const configsProvider = new ConfigsTreeProvider(workspace, config);
  ctx.subscriptions.push(configsProvider);
  ctx.subscriptions.push(
    vscode.window.createTreeView('ssh-fleet.configs', { treeDataProvider: configsProvider })
  );

  const taskTreeProvider = new TaskTreeProvider(
    config.config, config.onDidChange, selection, workspace, prefs, config
  );
  ctx.subscriptions.push(taskTreeProvider);
  const taskTreeView = vscode.window.createTreeView('ssh-fleet.tasks', {
    treeDataProvider: taskTreeProvider,
    manageCheckboxStateManually: true,
    dragAndDropController: taskTreeProvider
  });
  ctx.subscriptions.push(taskTreeView);
  ctx.subscriptions.push(taskTreeProvider.bindCheckbox(taskTreeView));

  const statusBar = new StatusBar(registry, selection, config.config, serverFilter);
  ctx.subscriptions.push(statusBar);
  ctx.subscriptions.push(config.onDidChange(c => statusBar.refresh(c)));
  ctx.subscriptions.push(selection.onDidChange(() => statusBar.refresh()));

  const mirrorStatusBar = new MirrorStatusBar(mirror);
  ctx.subscriptions.push(mirrorStatusBar);

  // Drive context keys for viewsWelcome conditionals: `ssh-fleet.hasServers`
  // gates the "no servers" empty state vs the "configured but disconnected"
  // state; `ssh-fleet.connectedCount` lets later contexts use exact counts.
  // Refreshed on every config / registry change.
  const refreshCtxKeys = (): void => {
    void vscode.commands.executeCommand(
      'setContext', 'ssh-fleet.hasServers', config.config.servers.length > 0
    );
    void vscode.commands.executeCommand(
      'setContext', 'ssh-fleet.connectedCount', registry.connectedCount()
    );
  };
  refreshCtxKeys();
  ctx.subscriptions.push(config.onDidChange(refreshCtxKeys));
  ctx.subscriptions.push(registry.onChange(refreshCtxKeys));

  // Optional sleep-prevention with latching semantics.
  // Off by default; opt-in via `settings.preventSleep: true` in config.
  //
  // Lifecycle: the inhibitor starts the FIRST time this window shows a
  // real sign of SSH Fleet use after activation, and stays running until
  // the window closes (or the operator toggles the setting back off).
  // Visibility going false / connections dropping / panel closing don't
  // stop it — operators want predictable "keep awake until I'm done".
  //
  // Triggers (any one latches; subsequent events are no-ops):
  //  - TreeView becomes visible AFTER an activation grace period (the
  //    grace ignores the synthetic visibility=true event VSCode fires at
  //    startup for a previously-pinned sidebar — that fires in every
  //    window regardless of operator intent and would defeat the point
  //    of latching to "actively used windows")
  //  - First server connect (registry connectedCount goes 0 → ≥1)
  //  - Console panel opens
  const keepAwake = new KeepAwake(ctx.extensionUri);
  ctx.subscriptions.push(keepAwake);

  const ACTIVATION_GRACE_MS = 5_000;
  const activatedAt = Date.now();
  let latched = false;
  log.info(`KeepAwake: gate init preventSleep=${config.config.settings.preventSleep} treeViewVisible=${serverTreeView.visible} connections=${registry.connectedCount()} panelOpen=${SshFleetWebviewPanel.isOpen()}`);

  const tryLatch = (reason: string): void => {
    if (latched) {
      log.info(`KeepAwake: latch skipped (already latched) reason=${reason}`);
      return;
    }
    if (!config.config.settings.preventSleep) {
      log.info(`KeepAwake: latch skipped (preventSleep=false) reason=${reason}`);
      return;
    }
    latched = true;
    log.info(`KeepAwake: latched reason=${reason}`);
    keepAwake.start();
  };

  // Triggers
  ctx.subscriptions.push(serverTreeView.onDidChangeVisibility(e => {
    const elapsed = Date.now() - activatedAt;
    const inGrace = elapsed < ACTIVATION_GRACE_MS;
    log.info(`KeepAwake: treeView visibility=${e.visible} elapsed=${elapsed}ms inGrace=${inGrace}`);
    if (e.visible && !inGrace) tryLatch('treeView-visible');
  }));
  ctx.subscriptions.push(registry.onChange(() => {
    const n = registry.connectedCount();
    if (n > 0) tryLatch(`connect (count=${n})`);
  }));
  ctx.subscriptions.push(SshFleetWebviewPanel.onDidChangeOpenState(() => {
    if (SshFleetWebviewPanel.isOpen()) tryLatch('panel-open');
  }));
  // After grace expires, evaluate once: if the sidebar has been visible
  // throughout (operator's primary work surface), latch now.
  const graceTimer = setTimeout(() => {
    const visible = serverTreeView.visible;
    const conns = registry.connectedCount();
    const panel = SshFleetWebviewPanel.isOpen();
    log.info(`KeepAwake: grace expired visible=${visible} connections=${conns} panelOpen=${panel}`);
    if (visible || conns > 0 || panel) tryLatch('grace-expired');
  }, ACTIVATION_GRACE_MS + 100);
  ctx.subscriptions.push({ dispose: () => clearTimeout(graceTimer) });

  // Operator can disable mid-session by flipping the setting; flipping
  // it back on re-evaluates current state and latches if appropriate.
  ctx.subscriptions.push(config.onDidChange(() => {
    const enabled = config.config.settings.preventSleep;
    if (!enabled) {
      if (latched) {
        log.info('KeepAwake: config flipped to false — stopping');
        keepAwake.stop();
        latched = false;
      }
    } else if (!latched) {
      if (serverTreeView.visible
          || registry.connectedCount() > 0
          || SshFleetWebviewPanel.isOpen()) {
        tryLatch('config-flipped-on');
      }
    }
  }));

  // Per-window mount indicator — shows e.g. "$(plug) SSH: dev-node1" in
  // mount-windows so the operator always knows which remote they're on.
  const mountStatusBar = new MountStatusBar();
  ctx.subscriptions.push(mountStatusBar);

  const fsp = new SshFileSystemProvider(registry, config);
  ctx.subscriptions.push(fsp);
  ctx.subscriptions.push(vscode.workspace.registerFileSystemProvider(SSH_SCHEME, fsp, {
    isCaseSensitive: true
  }));

  const cmdCtx: CommandContext = {
    extension: ctx,
    workspace,
    config,
    secrets,
    registry,
    hostKeys,
    output,
    history,
    bookmarks,
    mirror,
    tree: serverTreeProvider,
    selection,
    cwd,
    schedule,
    serverFilter,
    prefs,
    backupHealth,
    workdirState,
    connectionHistory,
    terminals: new Map()
  };
  for (const d of registerCommands(cmdCtx)) {
    ctx.subscriptions.push(d);
  }

  // Track when the active editor has cross-server siblings so editor/title
  // can show 'Save All' / 'Diff with sibling' affordances contextually.
  registerSiblingTracker(ctx);

  // Save-prompt for mirror-tracked files. Whenever the operator saves a
  // file that the mirror system is tracking, ask whether to push the new
  // bytes to the remote. Same prompt fires for any of: left-click open,
  // right-click "Open file in editor", `:se` — they all download via the
  // mirror, so they all run through this hook on save.
  //
  // Save All on multiple mirrored files fires onDidSaveTextDocument once
  // per file in a tight burst. VSCode's `showInformationMessage` is a
  // singleton — a second prompt closes the first with `undefined`,
  // silently dropping the first file's push. Serialise prompts via a
  // promise tail (same pattern as SecretStore.promptTail) so each
  // operator decision lands on its own file.
  let pushPromptTail: Promise<unknown> = Promise.resolve();
  ctx.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async doc => {
    if (doc.uri.scheme !== 'file') return;
    // forUri (not get) so files matching the mirror path convention but
    // not yet in this machine's manifest are auto-tracked on first save.
    const entry = mirror.forUri(doc.uri);
    if (!entry) return;

    const myPrompt = pushPromptTail.then(() =>
      vscode.window.showInformationMessage(
        `Push to ${entry.serverName}:${entry.remotePath}?`,
        { modal: false },
        'Push', 'Cancel'
      )
    );
    pushPromptTail = myPrompt.catch(() => undefined);
    const choice = await myPrompt;
    if (choice !== 'Push') return;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Pushing to ${entry.serverName}:${entry.remotePath}…` },
        () => mirror.push(entry)
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`SSH Fleet: push failed — ${(err as Error).message}`);
    }
  }));

  // Tab cleanup at activate time:
  //  (1) Kill zombie SSH Fleet Console webviews left over from reload.
  //  (2) In mount-windows, kill the auto-opened Welcome / Get Started tab.
  // The Welcome tab in modern VSCode is a `TabInputCustom` (walkthrough
  // editor) rather than a `TabInputWebview`, so we test both.
  const isMountWindow = (vscode.workspace.workspaceFolders ?? [])
    .some(f => f.uri.scheme === SSH_SCHEME);
  const isWelcomeTab = (tab: vscode.Tab): boolean => {
    const label = tab.label.toLowerCase();
    if (label === 'welcome' || label === 'get started') return true;
    const vt = (tab.input instanceof vscode.TabInputWebview ||
                tab.input instanceof vscode.TabInputCustom)
      ? tab.input.viewType.toLowerCase() : '';
    return vt.includes('walkthrough') || vt.includes('welcome');
  };
  const sweepTabs = (): void => {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputWebview &&
            tab.input.viewType.includes('ssh-fleet.panel')) {
          void vscode.window.tabGroups.close(tab);
          continue;
        }
        if (isMountWindow && isWelcomeTab(tab)) {
          void vscode.window.tabGroups.close(tab);
        }
      }
    }
  };
  sweepTabs();
  // Welcome is opened by VSCode *after* extensions activate, so the
  // sweep above misses it. Subscribe to tab-change events and close any
  // newly-opened Welcome tab. We dispose the listener after first hit
  // (Welcome only opens once at startup) to avoid lifetime leaks.
  if (isMountWindow) {
    const sub = vscode.window.tabGroups.onDidChangeTabs(e => {
      for (const tab of e.opened) {
        if (isWelcomeTab(tab)) void vscode.window.tabGroups.close(tab);
      }
    });
    ctx.subscriptions.push(sub);
  }

  // Webview panel — primary UI. Open lazily: only when the user
  // *intentionally* engages with SSH Fleet (clicks the activity-bar icon,
  // making the Servers TreeView visibility flip from hidden→visible).
  // Auto-opening at activate-time is wrong because the extension activates
  // on every window (including local-code projects that have nothing to
  // do with SSH Fleet) — those windows shouldn't sprout an SSH Fleet Console
  // tab uninvited.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('ssh-fleet.openPanel', () => {
      SshFleetWebviewPanel.showOrCreate(cmdCtx);
    })
  );
  // No auto-open of Console on visibility change. VSCode fires
  // `onDidChangeVisibility` during startup for any pinned sidebar,
  // which used to open Console in every window (even ones not using
  // SSH Fleet). Console now opens only on operator action.
  //
  // Auto-open trigger: the FIRST server-connect of the session. The
  // operator just engaged with SSH Fleet functionally, so Console should
  // appear (preserveFocus=true so it doesn't yank focus). After that,
  // Console stays under operator control — closing it is respected;
  // additional connects don't resurrect it.
  //
  // EXCEPT in mount windows: those are file-editing surfaces, and the
  // FileSystemProvider connects to remotes mechanically (SFTP for
  // readFile/writeFile) — that's not an operator action that needs
  // Console. Skip the auto-open entirely if the workspace is rooted in
  // an `ssh-fleet://` URI. Operator can still Open Panel explicitly.
  let consoleAutoOpened = isMountWindow;
  ctx.subscriptions.push(registry.onChange(serverName => {
    if (consoleAutoOpened) return;
    if (SshFleetWebviewPanel.isOpen()) {
      consoleAutoOpened = true;
      return;
    }
    const conn = registry.list().find(c => c.server.name === serverName);
    if (conn?.state === 'connected') {
      consoleAutoOpened = true;
      SshFleetWebviewPanel.showOrCreate(cmdCtx, true);
    }
  }));

  // Resume any persisted schedules. Each tick dispatches the saved
  // command through the panel — but ONLY if the panel is already open.
  // Schedules must never resurrect a closed Console (would surprise the
  // operator at activate time, again per-tick on multiple windows).
  // Ticks pause silently while Console is closed and resume on the next
  // explicit Open Panel.
  schedule.resumeAll((task: ScheduledTask) => {
    if (!SshFleetWebviewPanel.isOpen()) return;
    const panel = SshFleetWebviewPanel.showOrCreate(cmdCtx, true);
    void panel.dispatchScheduled(task);
  });

  log.info(
    `SSH Fleet ready — workspace: ${workspace.root ?? '(unset)'}, ` +
    `${config.config.servers.length} server(s) configured`
  );
}

export function deactivate(): void {
  log.info('Deactivating SSH Fleet extension');
}
