import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  type ExtToWebMessage,
  type ExtToWebSingleMessage,
  type OutputKind,
  type PanelStateSnapshot,
  type WebToExtMessage
} from './messages.js';
import type { CommandContext } from '../commands/context.js';
import { confirmAndSwitchActiveConfig } from '../commands/helpers.js';
import type { OutputEvent } from '../output/channel.js';
import * as YAML from 'yaml';
import { runRemoteCommand } from '../ssh/runner.js';
import type { SshConnection } from '../ssh/connection.js';
import { classifySftpError, isSftpEnoent } from '../ssh/sftp.js';
import { detectInteractive, detectShellBuiltinPitfall, detectStdinBlocking } from '../features/safety.js';
import { wrapBackup, buildSftpBackupCommand } from '../features/backup.js';
import { confirmDestCheck } from '../features/destCheck.js';
import { detectModifying, globMatch } from '../features/safety.js';
import { buildUri } from '../views/sshFileSystemProvider.js';
import { log } from '../util/logger.js';
import { ServerFilterState } from '../state/serverFilter.js';
import type { ScheduledTask } from '../state/schedule.js';

const VIEW_TYPE = 'ssh-fleet.panel';

/**
 * Owns the SSH Fleet Console webview. Singleton — calling showOrCreate again
 * just reveals the existing tab. The webview is the rich-output + cwd-bar +
 * command-input surface; selection comes from the native TreeView (via
 * SelectionState).
 */
export class SshFleetWebviewPanel {
  private static current: SshFleetWebviewPanel | undefined;
  /** Fires whenever the singleton transitions between open and closed.
   *  Listeners read `isOpen()` to learn the new state. */
  private static readonly openStateEmitter = new vscode.EventEmitter<void>();
  static readonly onDidChangeOpenState = SshFleetWebviewPanel.openStateEmitter.event;

  /** True when a Console panel is currently open in this window. Used by
   *  the schedule-resume gate in `extension.ts` so a tick never
   *  resurrects a closed Console — schedules pause while Console is
   *  closed and resume on the next explicit Open Panel. */
  static isOpen(): boolean {
    return SshFleetWebviewPanel.current !== undefined;
  }

  /**
   * Show or create the panel.
   *
   * `preserveFocus` defaults to `false` so explicit user invocations
   * (e.g. clicking "Open Panel") bring the panel forward as expected.
   * Background callers — schedule ticks while Console is open — pass
   * `true` so we DON'T pull the panel forward at all when it already
   * exists. (Even `reveal(col, preserveFocus=true)` brings the panel to
   * the front of its column, which hides whatever tab the user is
   * editing in that column. The webview still receives postMessage just
   * fine when hidden, thanks to `retainContextWhenHidden: true`.)
   */
  static showOrCreate(ctx: CommandContext, preserveFocus = false): SshFleetWebviewPanel {
    if (SshFleetWebviewPanel.current) {
      // Only reveal on user-driven shows. Background events leave the
      // current tab where it is and just postMessage to the hidden panel.
      if (!preserveFocus) {
        SshFleetWebviewPanel.current.panel.reveal();
      }
      return SshFleetWebviewPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'SSH Fleet Console',
      // Open in the operator's currently active tab group — Console
      // becomes a tab alongside whatever they were editing rather than
      // forcing a new editor split. `preserveFocus` plumbed through:
      //   - false (explicit "Open Panel"): focus moves to Console
      //   - true (background, e.g. activity-bar visibility flip):
      //     Console appears but the active editor stays focused.
      { viewColumn: vscode.ViewColumn.Active, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // Lets Cmd+F / Ctrl+F open VSCode's native find-in-page widget
        // over the webview — operators can search through accumulated
        // output lines without us implementing a custom find UI.
        enableFindWidget: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extension.extensionUri, 'media')]
      }
    );
    SshFleetWebviewPanel.current = new SshFleetWebviewPanel(panel, ctx);
    SshFleetWebviewPanel.openStateEmitter.fire();
    return SshFleetWebviewPanel.current;
  }

  private readonly subs: vscode.Disposable[] = [];
  /** Set while a broadcast is in flight; flipped to true on cancel. */
  private currentRun: { cancelled: boolean } | undefined;

  /**
   * Postmessage batching — under high-volume streams (`tail -f`,
   * verbose deploys), per-line `webview.postMessage()` IPC dominated the
   * extension-host CPU. We coalesce all webview-bound messages within a
   * short window (~16ms), wrap them in an `outputBatch`, and unpack on
   * the webview side. Order is preserved; batch size is bounded.
   */
  private postQueue: ExtToWebSingleMessage[] = [];
  private postFlushTimer: NodeJS.Timeout | undefined;
  private static readonly POST_FLUSH_MS = 16;
  private static readonly POST_FLUSH_HARD_CAP = 500;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly ctx: CommandContext
  ) {
    this.panel.iconPath = vscode.Uri.joinPath(
      ctx.extension.extensionUri, 'resources', 'icons', 'activity-bar.svg'
    );

    void this.renderHtml();

    this.subs.push(panel.webview.onDidReceiveMessage((m: WebToExtMessage) => this.onMessage(m)));
    this.subs.push(panel.onDidDispose(() => this.dispose()));

    this.subs.push(ctx.config.onDidChange(() => void this.pushState()));
    this.subs.push(ctx.registry.onChange(() => void this.pushState()));
    this.subs.push(ctx.workspace.onDidChange(() => void this.pushState()));
    this.subs.push(ctx.selection.onDidChange(() => void this.pushState()));
    this.subs.push(ctx.cwd.onDidChange(() => void this.pushState()));
    this.subs.push(ctx.output.onEvent(ev => this.relayOutput(ev)));
    this.subs.push(ctx.prefs.onDidChange(() => void this.pushState()));
    this.subs.push(ctx.serverFilter.onDidChange(() => void this.pushState()));
    this.subs.push(ctx.backupHealth.onDidChange(() => void this.pushState()));
    // Re-push the schedule status after each tick so the modal & header
    // indicator can display "last ran X seconds ago" without polling.
    this.subs.push(ctx.schedule.onDidChange(() => void this.replyScheduleStatus()));
  }

  reveal(): void {
    this.panel.reveal();
  }

  // ---------- Render ----------

  private async renderHtml(): Promise<void> {
    const ext = this.ctx.extension.extensionUri;
    const htmlPath = vscode.Uri.joinPath(ext, 'media', 'webview', 'index.html');
    const stylePath = vscode.Uri.joinPath(ext, 'media', 'webview', 'style.css');
    const scriptPath = vscode.Uri.joinPath(ext, 'media', 'webview', 'main.js');

    const styleUri = this.panel.webview.asWebviewUri(stylePath);
    const scriptUri = this.panel.webview.asWebviewUri(scriptPath);
    const cspSource = this.panel.webview.cspSource;
    const nonce = crypto.randomBytes(16).toString('base64');

    let html: string;
    try {
      html = await fs.readFile(htmlPath.fsPath, 'utf-8');
    } catch (err) {
      log.error('Failed to read webview HTML', err);
      html = '<html><body>Failed to load SSH Fleet UI.</body></html>';
    }
    html = html
      .replace(/\$\{cspSource\}/g, cspSource)
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{styleUri\}/g, styleUri.toString())
      .replace(/\$\{scriptUri\}/g, scriptUri.toString());
    this.panel.webview.html = html;
  }

  private async buildSnapshot(): Promise<PanelStateSnapshot> {
    const cfg = this.ctx.config.config;
    const ws = this.ctx.workspace;
    const activeFull = await ws.resolveActiveConfig();
    const availableConfigs = await ws.listConfigs();

    const selectedSet = new Set(this.ctx.selection.servers);
    // Iterate by *config order* (cfg.servers list) instead of click
    // order. SelectionState stores ticks in a Set keyed by click time,
    // so a raw `selection.servers` reflects the order the operator
    // clicked checkboxes — clicking server-3 then -1 then -2 made output
    // render that way too. Operators expect stable list-order grouping.
    const selected = cfg.servers
      .map(s => s.name)
      .filter(name => selectedSet.has(name));
    const cwdCommon = this.ctx.cwd.commonCwd(selected);
    const cwdByServer: Record<string, string> = {};
    for (const name of selected) {
      cwdByServer[name] = this.ctx.cwd.cwdOf(name);
    }
    const connected = this.ctx.registry.connectedCount();
    const bookmarks = this.ctx.bookmarks.list(cfg.bookmarks);

    const warnByServer: Record<string, { label: string; color: string }> = {};
    for (const s of cfg.servers) {
      const w = warningLabelFor(s, cfg);
      if (w) warnByServer[s.name] = w;
    }

    const availableEnvs = ServerFilterState.availableEnvs(cfg.servers);
    const availableModules = ServerFilterState.availableModules(cfg.servers);

    // Aggregate backup-dir health across the operator's current
    // selection (or all servers when nothing is ticked, so the badge has
    // a sensible default). 'failed' wins — gray badge with details.
    const backupHealthScope = selected.length > 0 ? selected : cfg.servers.map(s => s.name);
    const agg = this.ctx.backupHealth.aggregate(backupHealthScope);
    const failedDetail = agg.failed.length > 0
      ? agg.failed.map(f => f.reason ? `${f.name}: ${f.reason}` : f.name).join('; ')
      : undefined;

    return {
      selectedCount: selected.length,
      totalServers: cfg.servers.length,
      connectedCount: connected,
      cwdCommon,
      cwdMixed: selected.length > 1 && cwdCommon === undefined,
      cwdByServer,
      bookmarks,
      workspaceRoot: ws.root,
      activeConfig: activeFull ? path.basename(activeFull) : undefined,
      availableConfigs,
      warnByServer,
      backupEnabled: !!cfg.safety.autoBackup.enabled,
      backupDir: cfg.safety.autoBackup.enabled ? cfg.safety.autoBackup.backupDir : undefined,
      backupHealth: failedDetail !== undefined
        ? { overall: agg.overall, failedDetail }
        : { overall: agg.overall },
      hideTimestamps: this.ctx.prefs.hideTimestamps,
      deselectAfterRun: this.ctx.prefs.deselectAfterRun,
      availableEnvs,
      availableModules,
      filterEnvs: this.ctx.serverFilter.selectedEnvs,
      filterModules: this.ctx.serverFilter.selectedModules,
      filterText: this.ctx.serverFilter.filterText,
      aliases: { ...cfg.aliases },
      lsCommand: cfg.settings.lsCommand,
      archiveMinDepth: cfg.settings.archiveMinDepth,
      shortenHostnames: cfg.settings.shortenHostnames,
      lsFlagsOverride: this.ctx.workdirState.get<string>('ssh-fleet.lsFlags.v1') ?? null
    };
  }

  private async pushState(): Promise<void> {
    const state = await this.buildSnapshot();
    this.postToWeb({ type: 'state', state });
  }

  private relayOutput(ev: OutputEvent): void {
    // OutputEvent.kind already maps 1:1 to webview OutputKind for the new
    // info/warn/error variants. The legacy 'line' kind maps to 'info' for
    // backwards compatibility with output.line() callers.
    const kind: OutputKind = ev.kind === 'line' ? 'info' : ev.kind;
    const msg: ExtToWebMessage = {
      type: 'output',
      kind,
      text: ev.text,
      ts: ev.ts
    };
    if (ev.serverName) {
      msg.serverName = ev.serverName;
    }
    this.postToWeb(msg);
  }

  private postCmdEcho(text: string, warn = false): void {
    this.postToWeb({
      type: 'output',
      kind: warn ? 'cmdWarn' : 'cmd',
      text,
      ts: Date.now()
    });
  }

  /**
   * Emit a non-cmd output line into the CURRENT cmd-block. Use for per-
   * server results, validation messages, and trailing summaries that
   * follow a `postCmdEcho(...)` for the same logical command. Without
   * this, naïve `postCmdEcho` calls open new blocks per line and the
   * output looks visually fragmented (each line gets its own `>` glyph).
   *
   * Mirror to OutputChannel so the operator has a searchable record.
   */
  private postLine(text: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    this.postToWeb({
      type: 'output',
      kind,
      text,
      ts: Date.now()
    });
  }

  /**
   * Webview-context cap enforcement: same policy as commands/* helpers.ts
   * `enforceServerCap`, but routes the failure message into the webview
   * (postLine) instead of a bottom-right toast — matches the surface the
   * user just acted in. Returns true when the action may proceed.
   */
  private enforceCap(serverCount: number, actionLabel: string): boolean {
    const cap = this.ctx.config.config.settings.maxServersPerAction;
    if (cap <= 0 || serverCount <= cap) return true;
    this.postLine(
      `${actionLabel} blocked — ${serverCount} servers selected exceeds ` +
      `settings.maxServersPerAction = ${cap}. ` +
      `Untick servers, or raise the cap in your config file.`,
      'error'
    );
    return false;
  }

  /**
   * File-size + binary check before clicking / opening a remote file.
   * Two-tier:
   *   - size > maxFileDownloadSize → hard reject (prevents accidental
   *     gigabyte downloads that freeze the editor / fill disk).
   *   - size > maxFileOpenSize OR extension looks binary → modal confirm.
   * `mode === 'open'` applies both checks; `mode === 'download'` only
   * applies the hard download cap (downloading a binary is a normal
   * workflow — `:dl` shouldn't gate that).
   * Returns true when the action may proceed.
   */
  private async guardFileOpen(
    server: string,
    remotePath: string,
    sizeBytes: number,
    mode: 'open' | 'download'
  ): Promise<boolean> {
    const settings = this.ctx.config.config.settings;
    const dlCapMb = settings.maxFileDownloadSize;
    const openWarnMb = settings.maxFileOpenSize;
    const sizeMb = sizeBytes / (1024 * 1024);

    if (dlCapMb > 0 && sizeMb > dlCapMb) {
      this.postLine(
        `✗ ${server}:${remotePath} is ${sizeMb.toFixed(1)} MB — over the hard cap ` +
        `settings.maxFileDownloadSize = ${dlCapMb} MB. ` +
        `Use scp / rsync for a file this large, or raise the cap in your config file (at your own risk).`,
        'error'
      );
      return false;
    }
    if (mode === 'download') return true; // size OK, no editor-open checks

    // Editor-open path: warn on large size or likely-binary extension.
    const looksBinary = isLikelyBinary(remotePath);
    const tooLargeForEditor = openWarnMb > 0 && sizeMb > openWarnMb;
    if (!looksBinary && !tooLargeForEditor) return true;

    const reasons: string[] = [];
    if (tooLargeForEditor) reasons.push(`${sizeMb.toFixed(1)} MB > ${openWarnMb} MB`);
    if (looksBinary) reasons.push('looks binary');
    const proceed = await vscode.window.showWarningMessage(
      `Open ${server}:${remotePath} in editor?`,
      {
        modal: true,
        detail:
          `${reasons.join(' · ')}.\n\n` +
          (looksBinary
            ? 'Editor may render binary content as garbage.'
            : 'Large files render slowly and use significant memory.')
      },
      'Open'
    );
    return proceed === 'Open';
  }

  // ---------- Message dispatch ----------

  private async onMessage(msg: WebToExtMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready': {
          const state = await this.buildSnapshot();
          this.postToWeb({ type: 'init', state });
          // Also seed the schedule indicator so the header button reflects
          // the persisted schedule state immediately after the panel opens.
          await this.replyScheduleStatus();
          return;
        }
        case 'runCommand': {
          await this.dispatchCommand(msg.command);
          return;
        }
        case 'runSpecial': {
          await this.handleSpecial(msg.line);
          return;
        }
        case 'cancelRun': {
          if (this.currentRun) {
            this.currentRun.cancelled = true;
            this.postLine('(cancel requested — waiting for in-flight commands to finish)');
          }
          return;
        }
        case 'pathClick':
        case 'pathOpen': {
          await this.handlePathOpen(msg.server, msg.path);
          return;
        }
        case 'bookmarkAdd': {
          await this.ctx.bookmarks.add(msg.path);
          await this.pushState();
          return;
        }
        case 'bookmarkRemove': {
          await this.ctx.bookmarks.remove(msg.path);
          await this.pushState();
          return;
        }
        case 'lsFlagsChanged': {
          // Persist to the file-backed workdir state so the override
          // survives a profile reset (it's stored under the workdir,
          // not under the user profile). No state push back: the
          // webview already has the value it just sent us.
          await this.ctx.workdirState.update('ssh-fleet.lsFlags.v1', msg.flags);
          return;
        }
        case 'openConfig':
          await vscode.commands.executeCommand('ssh-fleet.openConfig');
          return;
        case 'reloadConfig':
          await vscode.commands.executeCommand('ssh-fleet.reloadConfig');
          return;
        case 'switchActiveConfig': {
          const dir = this.ctx.workspace.configDir();
          if (!dir) return;
          const target = path.join(dir, msg.configName);
          await confirmAndSwitchActiveConfig(this.ctx, target);
          return;
        }
        case 'scheduleGet': {
          await this.replyScheduleStatus();
          return;
        }
        case 'scheduleStart': {
          const cfgFull = await this.ctx.workspace.resolveActiveConfig();
          if (!cfgFull) {
            this.postLine('(no active config to attach the schedule to — open a config first)', 'warn');
            return;
          }
          // Hard-block scheduling modifying commands. Unattended ticks
          // can't show modal-confirm / dest-check, and auto-backup wraps
          // would pile up endless backup files in the backup dir. If the
          // operator really needs a periodic destructive op, write a
          // task with explicit safety semantics rather than a raw
          // schedule.
          const modifyingVerb = detectModifying(msg.command);
          if (modifyingVerb) {
            this.postLine(
              `Schedule blocked — '${modifyingVerb}' is destructive. Scheduled commands ` +
              `bypass modal confirm / dest-check / auto-backup, so destructive verbs ` +
              `(rm, mv, cp, sed -i, > redirect …) are refused for unattended runs. ` +
              `Use a one-shot broadcast or a task with explicit safety wrapping instead.`,
              'error'
            );
            return;
          }
          const cfgName = path.basename(cfgFull);
          // Schedule applies to all currently-connected servers at each
          // tick (servers can join / leave between ticks). We don't freeze
          // a selection — `serverNames: []` is the sentinel for "live
          // registry list".
          await this.ctx.schedule.start(cfgName, {
            command: msg.command,
            intervalSec: msg.intervalSec,
            serverNames: [],
            silent: !!msg.silent
          }, task => void this.dispatchScheduled(task));
          await this.replyScheduleStatus();
          this.postLine(
            `(scheduled "${msg.command}" every ${msg.intervalSec}s on all connected servers` +
            `${msg.silent ? ', silent mode' : ''})`
          );
          return;
        }
        case 'scheduleStop': {
          const cfgFull = await this.ctx.workspace.resolveActiveConfig();
          if (!cfgFull) return;
          const cfgName = path.basename(cfgFull);
          await this.ctx.schedule.stop(cfgName);
          await this.replyScheduleStatus();
          this.postLine('(schedule stopped)');
          return;
        }
        case 'aliasesGet': {
          this.postToWeb({
            type: 'aliasesList',
            aliases: { ...this.ctx.config.config.aliases }
          });
          return;
        }
        case 'aliasesSave': {
          await this.saveAliasesToActiveConfig(msg.aliases);
          await this.ctx.config.reload();
          return;
        }
        case 'prefsSet': {
          if (typeof msg.hideTimestamps === 'boolean') {
            await this.ctx.prefs.setHideTimestamps(msg.hideTimestamps);
          }
          if (typeof msg.deselectAfterRun === 'boolean') {
            await this.ctx.prefs.setDeselectAfterRun(msg.deselectAfterRun);
          }
          return;
        }
        case 'filterSet': {
          if (msg.envs !== undefined) this.ctx.serverFilter.setEnvs(msg.envs);
          if (msg.modules !== undefined) this.ctx.serverFilter.setModules(msg.modules);
          if (msg.text !== undefined) this.ctx.serverFilter.setText(msg.text);
          return;
        }
        case 'filterClear': {
          this.ctx.serverFilter.clear();
          return;
        }
        case 'uploadPickFiles': {
          const picked = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            openLabel: 'Pick',
            title: 'Pick local file(s) to upload'
          });
          const list = picked ?? [];
          this.postToWeb({
            type: 'uploadFilesPicked',
            paths: list.map(u => u.fsPath),
            names: list.map(u => u.path.split('/').pop() ?? '')
          });
          return;
        }
        case 'uploadAdhoc': {
          await this.handleUploadAdhoc(msg.paths, msg.dest, msg.exec);
          return;
        }
        case 'pathCopyContent': {
          await this.handleCopyContent(msg.server, msg.path);
          return;
        }
        case 'pathOpenOnSelected': {
          // Reuse the existing :se logic via runSpecial.
          await this.handleSpecial(`:se ${msg.path}`);
          return;
        }
        case 'lsRemoteDir': {
          // Directory equivalent of :se — broadcast `cd <dir> && <ls>`
          // on every selected server. Using settings.lsCommand keeps
          // the listing format consistent with the cwd-bar and bookmark
          // navigation (e.g. operator-configured `ls -ltrah`).
          if (this.ctx.selection.servers.length === 0) {
            this.postLine('(no servers selected)', 'warn');
            return;
          }
          const ls = this.ctx.config.config.settings.lsCommand || 'ls -ltr';
          await this.dispatchCommand(`cd ${shellQuoteForRemote(msg.path)} && ${ls}`);
          return;
        }
        case 'pathDownload': {
          await this.handleDownloadFile(msg.server, msg.path);
          return;
        }
        case 'pathDownloadTar': {
          await this.handleDownloadTar(msg.server, msg.path);
          return;
        }
        case 'pathDelete': {
          await this.handleDelete(msg.server, msg.path, msg.isDir);
          return;
        }
        case 'pathDownloadMany': {
          await this.handleDownloadFileMany(msg.path);
          return;
        }
        case 'pathDownloadTarMany': {
          await this.handleDownloadTarMany(msg.path);
          return;
        }
        case 'pathDeleteMany': {
          await this.handleDeleteMany(msg.path, msg.isDir);
          return;
        }
        case 'notify': {
          const fn = msg.level === 'error' ? vscode.window.showErrorMessage
            : msg.level === 'warn' ? vscode.window.showWarningMessage
            : vscode.window.showInformationMessage;
          void fn(msg.text);
          return;
        }
        case 'pathComplete': {
          await this.handlePathComplete(msg.server, msg.partial, msg.reqId);
          return;
        }
        case 'commandComplete': {
          await this.handleCommandComplete(msg.server, msg.prefix, msg.reqId);
          return;
        }
      }
    } catch (err) {
      // Include msg.type in both surfaces — without it, "SSH Fleet: cannot
      // read property 'X' of undefined" gives no clue which webview action
      // triggered the failure. msg.type lets us reproduce six months later.
      const typeTag = (msg as { type?: string }).type ?? '<unknown>';
      log.error(`webview message handling failed [type=${typeTag}]`, err);
      void vscode.window.showErrorMessage(
        `SSH Fleet: ${typeTag} failed — ${(err as Error).message}`
      );
    }
  }

  // ---------- Command dispatch ----------

  private async dispatchCommand(rawCommand: string, opts: { skipEcho?: boolean } = {}): Promise<void> {
    let command = rawCommand.trim();
    if (!command) return;
    // Expand the first-token alias client-side. The broadcast path runs
    // commands via ssh2's `exec` channel (non-interactive bash -c), where
    // ~/.bashrc and the PTY-side alias init are NOT loaded — so a literal
    // `ll …` would fail with "command not found". Looking up the alias
    // here lets `ll` work the same way it does in the Open Terminal PTY,
    // without operators having to remember which path expands aliases.
    {
      const firstSpace = command.indexOf(' ');
      const head = firstSpace < 0 ? command : command.slice(0, firstSpace);
      const expansion = this.ctx.config.config.aliases[head];
      if (typeof expansion === 'string' && expansion.length > 0) {
        const rest = firstSpace < 0 ? '' : command.slice(firstSpace);
        command = expansion + rest;
      }
    }
    const selected = this.ctx.selection.servers;
    if (selected.length === 0) {
      this.postLine(`(no servers selected — tick boxes in the sidebar first)`, 'warn');
      return;
    }
    if (!this.enforceCap(selected.length, 'Broadcast')) return;

    // Echo the user's command into the output stream — modifying commands
    // get the warn-coloured block header so it stands out at a glance.
    // Recursive `cd && <suffix>` dispatches pass `skipEcho: true` so that
    // the cd, the cd→ status lines, and the suffix's output all stack into
    // the SAME block as the user's original command.
    if (!opts.skipEcho) {
      this.postCmdEcho(`> ${command}`, detectModifying(command));
    }

    // 1. cd interception → don't actually run on the wire, just update the
    //    tracked cwd. If the original line was `cd <path> && <suffix>` (e.g.
    //    a breadcrumb click that wants to follow the cd with `ls -ltrh`), the
    //    suffix is dispatched as a fresh command after the state lands.
    const cdPlan = this.ctx.cwd.parseCd(selected, command);
    if (cdPlan) {
      const result = await this.ctx.cwd.applyCd(cdPlan.targets);
      for (const ok of result.ok) {
        this.ctx.output.line(ok.name, `cd → ${ok.target}`);
      }
      for (const fail of result.failed) {
        this.ctx.output.line(fail.name, `cd failed: ${fail.reason}`);
      }
      await this.pushState();
      if (cdPlan.suffix && result.ok.length > 0) {
        // Suffix dispatch reuses the current block — no new echo header.
        await this.dispatchCommand(cdPlan.suffix, { skipEcho: true });
      }
      return;
    }

    // 2. Interactive command intercept (vim/top etc).
    const interactive = detectInteractive(command);
    if (interactive) {
      const action = await vscode.window.showWarningMessage(
        `'${interactive}' needs an interactive terminal — run on which server?`,
        { modal: false },
        ...selected.slice(0, 5).map(n => n)
      );
      if (action) {
        await vscode.commands.executeCommand('ssh-fleet.openTerminal', { serverName: action });
      }
      return;
    }

    // 2b. Shell-builtin pitfall hint. `history` / `alias` / `jobs` etc.
    // run successfully over non-interactive SSH but produce empty output
    // because the relevant shell state isn't populated. Don't block —
    // surface a hint inside the cmd-block so the operator sees it next
    // to the (likely empty) result and knows what to try instead.
    const builtinHint = detectShellBuiltinPitfall(command);
    if (builtinHint) {
      this.ctx.output.warn(builtinHint.hint);
    }

    // 2c. Stdin-blocking commands (`read`, bare `cat`, etc.) — these
    // would hang the entire task timeout waiting for input we never
    // send. Block with a confirm so the operator knows; "Run Anyway"
    // honors deliberate runs (e.g. testing the timeout behavior).
    const stdinBlock = detectStdinBlocking(command);
    if (stdinBlock) {
      const proceed = await vscode.window.showWarningMessage(
        `'${stdinBlock.name}' will hang the SSH session waiting for stdin.`,
        { modal: true, detail: stdinBlock.hint },
        'Run Anyway'
      );
      if (proceed !== 'Run Anyway') {
        this.postLine('(cancelled — would hang on stdin)', 'warn');
        return;
      }
    }

    // 3. Modifying command → confirm before broadcasting.
    let toRun = command;
    if (detectModifying(command)) {
      const proceed = await vscode.window.showWarningMessage(
        `Run modifying command on ${selected.length} ${selected.length === 1 ? 'server' : 'servers'}?`,
        { modal: true, detail: command },
        'Run'
      );
      if (proceed !== 'Run') {
        this.postLine('(cancelled)', 'warn');
        return;
      }
      const cfg = this.ctx.config.config;
      // Pre-flight: stat the destination on each target. If it already
      // exists, surface a modal so the operator can choose to overwrite.
      if (cfg.safety.destCheck.enabled) {
        const targets = selected
          .map(n => cfg.servers.find(s => s.name === n))
          .filter((s): s is NonNullable<typeof s> => !!s);
        const ok = await confirmDestCheck(
          command,
          targets,
          this.ctx.registry,
          cfg.safety.destCheck,
          cfg.safety.autoBackup.enabled
            ? `Auto-backup is enabled (backupDir: ${cfg.safety.autoBackup.backupDir}).`
            : 'Auto-backup is OFF — overwrites are NOT recoverable.'
        );
        if (!ok) {
          this.postLine('(cancelled — destination already exists)', 'warn');
          return;
        }
      }
      if (cfg.safety.autoBackup.enabled) toRun = wrapBackup(toRun, cfg.safety.autoBackup);
    }

    // 4. Per-server cwd-prepend, then broadcast.
    const perServer = this.ctx.cwd.prependFor(selected, toRun);
    const servers = selected
      .map(n => this.ctx.config.config.servers.find(s => s.name === n))
      .filter((s): s is NonNullable<typeof s> => !!s);

    this.postToWeb({
      type: 'runStarted',
      label: `"${command}"`,
      serverNames: servers.map(s => s.name)
    });
    this.ctx.output.header(`▶ Broadcasting to ${servers.length} server(s): ${command}`);
    await this.ctx.history.record('@broadcast', command);

    // Track this run so a Cancel from the webview can short-circuit the loop.
    const run = { cancelled: false };
    this.currentRun = run;
    let doneCount = 0;
    let failedCount = 0;
    const total = servers.length;

    const postProgress = (): void => {
      this.postToWeb({
        type: 'runProgress',
        doneCount,
        failedCount,
        totalCount: total
      });
    };

    const results = await Promise.all(servers.map(async server => {
      if (run.cancelled) {
        this.ctx.output.line(server.name, `✗ skipped (cancelled before start)`);
        failedCount += 1;
        postProgress();
        return { ok: false, name: server.name };
      }
      const cmdForServer = perServer.find(p => p.name === server.name)?.command ?? toRun;
      try {
        const conn = await this.ctx.registry.ensure(server);
        await this.ctx.cwd.ensureHome(conn);
        const result = await runRemoteCommand(conn, cmdForServer, {
          timeoutMs: defaultTimeoutMs(),
          onStdout: chunk => this.ctx.output.stream(server.name, chunk, 'stdout'),
          onStderr: chunk => this.ctx.output.stream(server.name, chunk, 'stderr')
        });
        // Only surface a footer on FAILURE — clean exits stay silent.
        // Same rule as the broadcast / taskRunner paths.
        const ok = result.exitCode === 0;
        if (!ok || result.timedOut) {
          const note = result.timedOut ? ' (timed out)' : '';
          this.ctx.output.line(server.name, `✗ exit ${result.exitCode}${note} (${(result.durationMs / 1000).toFixed(1)}s)`);
        }
        if (ok) doneCount += 1; else failedCount += 1;
        postProgress();
        return { ok, name: server.name };
      } catch (err) {
        this.ctx.output.line(server.name, `✗ error: ${(err as Error).message}`);
        failedCount += 1;
        postProgress();
        return { ok: false, name: server.name };
      }
    }));

    this.currentRun = undefined;
    const ok = results.filter(r => r.ok).length;
    const failed = results.length - ok;
    const cancelNote = run.cancelled ? ' · cancelled' : '';
    // Surface the failed server names directly in the summary so the
    // operator doesn't have to scroll through per-server output to figure
    // out which ones blew up. Cap the inline list to 3 to keep the line
    // short; "+N more" if there are more.
    const failedNames = results.filter(r => !r.ok).map(r => r.name);
    const failedTag = failed
      ? `, ${failed} failed (${failedNames.slice(0, 3).join(', ')}${failedNames.length > 3 ? ` +${failedNames.length - 3} more` : ''})`
      : '';
    this.ctx.output.header(`■ Done: ${ok}/${results.length} succeeded${failedTag}${cancelNote}`);
    this.postToWeb({
      type: 'runDone',
      label: `"${command}"`,
      ok,
      failed
    });

    // (Auto-deselect-after-run is intentionally NOT triggered here — it
    //  applies only to task runs. Ad-hoc commands and the `cd <path> &&
    //  <suffix>` navigation pattern shouldn't churn the user's selection,
    //  especially when broadcasting `cd` chains itself recursively
    //  re-enters dispatchCommand for the suffix.)
  }

  // ---------- Special `:` commands ----------

  private async handleSpecial(rawLine: string): Promise<void> {
    const line = rawLine.trim();
    const [head, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ').trim();

    switch (head) {
      case ':help':
        this.postCmdEcho(line);
        for (const l of [
          'Special:',
          '  :tasks                     list available tasks',
          '  :run <task-name>           run a task on selected servers',
          '  :se <remote-path>          open the remote file on every selected server',
          '  :dl <remote-path>          download the remote file from every selected server',
          '  :status                    selection + connection summary',
          '  :cwd                       per-server cwd breakdown',
          '  :clear                     clear console output',
          '  :help                      this list',
          'Anything else is broadcast as a shell command.'
        ]) {
          this.postLine(l);
        }
        return;

      case ':status': {
        this.postCmdEcho(line);
        const sel = this.ctx.selection.servers;
        this.postLine(`selected: ${sel.length} (${sel.join(', ') || 'none'})`);
        const conn = this.ctx.registry.list();
        this.postLine(`connected: ${conn.filter(c => c.state === 'connected').length}/${conn.length}`);
        return;
      }

      case ':cwd': {
        this.postCmdEcho(line);
        const breakdown = this.ctx.cwd.breakdown(this.ctx.selection.servers);
        if (breakdown.length === 0) {
          this.postLine('(no servers selected)', 'warn');
        }
        for (const b of breakdown) {
          this.postLine(`  ${b.name}: ${b.cwd}`);
        }
        return;
      }

      case ':tasks': {
        this.postCmdEcho(line);
        const tasks = this.ctx.config.config.tasks;
        if (tasks.length === 0) {
          this.postLine('(no tasks loaded)', 'warn');
          return;
        }
        for (const t of tasks) {
          const summary = t.type === 'command' ? t.command
            : t.type === 'upload' ? `${t.src} → ${t.dest}`
            : `script ${t.src}${t.args ? ' ' + t.args : ''}`;
          this.postLine(`  [${t.type}] ${t.name}: ${summary}`);
        }
        return;
      }

      case ':run': {
        this.postCmdEcho(line);
        if (!arg) {
          this.postLine(':run <task-name> — see :tasks for the list');
          return;
        }
        const task = this.ctx.config.config.tasks.find(t => t.name === arg);
        if (!task) {
          this.postLine(`task '${arg}' not found`, 'warn');
          return;
        }
        const selected = this.ctx.selection.servers;
        if (selected.length === 0) {
          this.postLine('(no servers selected)', 'warn');
          return;
        }
        await vscode.commands.executeCommand('ssh-fleet.runTaskByName', { taskName: arg });
        return;
      }

      case ':se': {
        this.postCmdEcho(line);
        if (!arg) {
          this.postLine(':se <remote-path> — opens the file on each selected server');
          return;
        }
        if (!arg.startsWith('/')) {
          this.postLine(`:se needs an absolute path (got "${arg}")`, 'warn');
          return;
        }
        const selected = this.ctx.selection.servers;
        if (selected.length === 0) {
          this.postLine('(no servers selected)', 'warn');
          return;
        }
        if (!this.enforceCap(selected.length, ':se')) return;
        // Multi-server confirm — the operator asked for ALL multi-server
        // actions to require an explicit OK. Skip for the trivially-safe
        // single-server case (`:se` on one server is just an open).
        if (selected.length > 1) {
          const ok = await vscode.window.showWarningMessage(
            `Open ${arg} on ${selected.length} servers?`,
            { modal: true, detail: selected.join(', ') },
            'Open'
          );
          if (ok !== 'Open') {
            this.postLine('(cancelled)', 'warn');
            return;
          }
        }
        // Same flow as left-click / right-click "Open file in editor": each
        // server downloads through the mirror system, the operator edits a
        // LOCAL copy, and saving triggers a "push to remote?" prompt
        // (see registerMirrorSavePrompt in extension.ts). Multi-server
        // opens stack side-by-side via ViewColumn.Beside.
        let opened = 0;
        for (let i = 0; i < selected.length; i++) {
          const serverName = selected[i];
          try {
            // Ensure connection BEFORE stat so the size guard always runs
            // (without this, an unconnected server would silently bypass
            // the guardFileOpen check and download anything).
            const serverCfg = this.ctx.config.config.servers.find(s => s.name === serverName);
            if (!serverCfg) throw new Error(`server '${serverName}' not in config`);
            const conn = await this.ctx.registry.ensure(serverCfg);
            const stat = await conn.sftp.stat(arg);
            if (!await this.guardFileOpen(serverName, arg, stat.size, 'open')) {
              this.postLine(`  ${serverName}: skipped (size / type guard)`, 'warn');
              continue;
            }
            const entry = await this.ctx.mirror.download(serverName, arg);
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.localPath));
            const column = i === 0 ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside;
            await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
            opened++;
          } catch (err) {
            this.postLine(`  ${serverName}: ✗ ${(err as Error).message}`, 'error');
          }
        }
        const summaryKind: 'info' | 'warn' = opened === 0 ? 'warn' : 'info';
        this.postLine(
          `(opened ${opened}/${selected.length} via mirror — saves prompt to push back)`,
          summaryKind
        );
        return;
      }

      case ':dl': {
        this.postCmdEcho(line);
        if (!arg) {
          this.postLine(':dl <remote-path> — downloads the file from each selected server');
          return;
        }
        if (!arg.startsWith('/')) {
          this.postLine(`:dl needs an absolute path (got "${arg}")`, 'warn');
          return;
        }
        const selected = this.ctx.selection.servers;
        if (selected.length === 0) {
          this.postLine('(no servers selected)', 'warn');
          return;
        }
        if (!this.enforceCap(selected.length, ':dl')) return;
        const results = await Promise.all(selected.map(async name => {
          try {
            // Ensure connection BEFORE stat so the download cap always
            // runs (otherwise an unconnected server's :dl would bypass).
            const serverCfg = this.ctx.config.config.servers.find(s => s.name === name);
            if (!serverCfg) throw new Error(`server '${name}' not in config`);
            const conn = await this.ctx.registry.ensure(serverCfg);
            const stat = await conn.sftp.stat(arg);
            if (!await this.guardFileOpen(name, arg, stat.size, 'download')) {
              return undefined;  // hard-cap rejection logged inside guard
            }
            const entry = await this.ctx.mirror.download(name, arg);
            this.postLine(`  ${name}: ✓ → ${entry.localPath}`);
            return entry.localPath;
          } catch (err) {
            this.postLine(`  ${name}: ✗ ${(err as Error).message}`, 'error');
            return undefined;
          }
        }));
        const ok = results.filter((p): p is string => !!p);
        if (ok.length === 0) {
          this.postLine('(no files downloaded)', 'warn');
          return;
        }
        // Single-server: open the result. Multi-server: offer to open the
        // first one (so the operator can verify) — they can drill into the
        // mirror tree via Reveal-in-Finder for the rest.
        if (ok.length === 1) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ok[0]));
          await vscode.window.showTextDocument(doc);
        } else {
          this.postLine(`(downloaded ${ok.length}; mirror tree at ${path.dirname(path.dirname(ok[0]))})`);
        }
        return;
      }

      case ':clear':
        this.postToWeb({ type: 'outputClear' });
        return;

      default:
        this.postLine(`unknown special command: ${head}. Try :help`, 'warn');
    }
  }

  // ---------- Path tab-completion (Level 2) ----------

  /**
   * Handle a `pathComplete` request from the webview. The webview sends
   * a partial path token (e.g. `/etc/h`); we split it into parent dir +
   * basename prefix, SFTP-readdir the parent on the picked server, and
   * return matches whose names start with the prefix.
   *
   * `~/` is expanded to the server's home (resolved via VirtualCwdState's
   * cached home) so `~/.bashr` Tab works the same as bash.
   */
  private async handlePathComplete(server: string, partial: string, reqId: number): Promise<void> {
    const send = (matches: { name: string; isDir: boolean }[]): void => {
      this.postToWeb({ type: 'pathCompleteResult', reqId, partial, matches });
    };
    const conn = this.ctx.registry.get(server);
    if (!conn || conn.state !== 'connected') {
      send([]);
      return;
    }
    // Resolve ~/ relative to the cached home for this server. If we don't
    // know home yet, give up — better than guessing.
    let resolved = partial;
    if (resolved.startsWith('~/') || resolved === '~') {
      const home = this.ctx.cwd.cwdOf(server);
      // cwdOf returns home if no live cwd; if it's still `~` we don't
      // know home, abort.
      if (home === '~') { send([]); return; }
      resolved = resolved === '~' ? home : home.replace(/\/$/, '') + resolved.slice(1);
    } else if (!resolved.startsWith('/')) {
      // Relative path — anchor to current cwd of the server.
      const cur = this.ctx.cwd.cwdOf(server);
      if (cur === '~') { send([]); return; }
      resolved = (cur.endsWith('/') ? cur : cur + '/') + resolved;
    }
    // Split into parent + prefix.
    const lastSlash = resolved.lastIndexOf('/');
    const parent = lastSlash === 0 ? '/' : resolved.slice(0, lastSlash);
    const prefix = resolved.slice(lastSlash + 1);
    try {
      const entries = await conn.sftp.readdir(parent);
      const matches = entries
        .filter(e => e.name.startsWith(prefix))
        .slice(0, 20)
        .map(e => ({ name: e.name, isDir: e.stat.isDirectory }))
        .sort((a, b) => {
          // Dirs first, then alphabetical — matches `ls -lp` instinct.
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      send(matches);
    } catch (err) {
      log.warn(`pathComplete readdir failed for ${server}:${parent}: ${(err as Error).message}`);
      send([]);
    }
  }

  /**
   * Tab on the first token at command position — list executables /
   * builtins / aliases on the remote whose name starts with `prefix`.
   * Uses bash's `compgen -c`; falls back to a PATH scan if compgen is
   * unavailable. Result count is capped to 30 to keep the dropdown
   * scannable (typical `ca`+Tab on a fat box yields hundreds otherwise).
   */
  private async handleCommandComplete(server: string, prefix: string, reqId: number): Promise<void> {
    const send = (matches: string[]): void => {
      this.postToWeb({ type: 'commandCompleteResult', reqId, prefix, matches });
    };
    const conn = this.ctx.registry.get(server);
    if (!conn || conn.state !== 'connected') {
      send([]);
      return;
    }
    if (!prefix || /[^A-Za-z0-9_.\-]/.test(prefix)) {
      // Reject empty / fishy prefixes — never inject prefixes that
      // could break out of the bash arg quoting via $() or `.
      send([]);
      return;
    }
    // `bash -c 'compgen -c "$1"' _ <prefix>` even if the login shell isn't bash.
    // Strip duplicates (common with aliases shadowing PATH binaries) + cap at 30.
    const cmd = `bash -c 'compgen -c -- "$1"' _ ${prefix}`;
    try {
      const r = await runRemoteCommand(conn, cmd, { timeoutMs: 4_000 });
      if (r.exitCode !== 0) { send([]); return; }
      const seen = new Set<string>();
      const matches: string[] = [];
      for (const raw of r.stdout.split('\n')) {
        const name = raw.trim();
        if (!name || !name.startsWith(prefix) || seen.has(name)) continue;
        seen.add(name);
        matches.push(name);
        if (matches.length >= 30) break;
      }
      matches.sort();
      send(matches);
    } catch (err) {
      log.warn(`commandComplete failed on ${server}: ${(err as Error).message}`);
      send([]);
    }
  }

  // ---------- Path click handler ----------

  private async handlePathOpen(server: string, remotePath: string): Promise<void> {
    const conn = this.ctx.registry.get(server);
    if (!conn) {
      this.postLine(`✗ ${server}: not connected — open Terminal first or click the plug icon`, 'error');
      return;
    }
    try {
      const stat = await conn.sftp.stat(remotePath);
      if (stat.isDirectory) {
        // Cd + ls on currently-selected servers — clicking a directory in the
        // output should land you in that dir AND show its contents (matches
        // the breadcrumb / bookmark / `:cwd` UX). Listing command comes from
        // `settings.lsCommand` so operators can configure it per-config.
        const sel = this.ctx.selection.servers;
        if (sel.includes(server)) {
          const ls = this.ctx.config.config.settings.lsCommand || 'ls -ltr';
          await this.dispatchCommand(`cd ${shellQuoteForRemote(remotePath)} && ${ls}`);
        } else {
          // Not selected — open in a new window (matches Mount Remote
          // Folder behaviour, avoids workbench reload that breaks live
          // SSH connections in this window).
          const uri = buildUri(server, remotePath);
          await vscode.commands.executeCommand('vscode.openFolder', uri, true);
        }
      } else {
        // Click opens via the mirror: SFTP-download into the workspace's
        // mirror dir, register tracking, then open the LOCAL copy. The
        // editor's title bar gets the Push/Pull buttons (because
        // `ssh-fleet.activeFileIsMirrored` flips on), so the operator can
        // edit offline and push back when ready instead of stream-saving
        // every keystroke through SFTP.
        if (!await this.guardFileOpen(server, remotePath, stat.size, 'open')) return;
        const entry = await this.ctx.mirror.download(server, remotePath);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.localPath));
        await vscode.window.showTextDocument(doc);
      }
    } catch (err) {
      this.postLine(`✗ ${server}:${remotePath} — ${(err as Error).message}`, 'error');
    }
  }

  // ---------- Ad-hoc upload ----------

  /**
   * Upload one-or-more local files to every ticked server.
   *
   * Picker + dest + exec live inline in the webview's upload row; this
   * method just consumes the values and runs the upload, streaming
   * results into a single output block.
   *
   * - Single file: dest may be a full path or a directory ending in `/`.
   * - Multi file: dest MUST end in `/` (validated client-side too).
   * - `exec === true` chmods every uploaded file to 0755 after writing.
   */
  private async handleUploadAdhoc(
    paths: readonly string[],
    dest: string,
    exec: boolean
  ): Promise<void> {
    const selected = this.ctx.selection.servers;
    if (selected.length === 0) {
      this.postLine('(upload — tick at least one server first)', 'warn');
      return;
    }
    if (!this.enforceCap(selected.length, 'Upload')) return;
    if (paths.length === 0) {
      this.postLine('(upload — pick at least one file via 📎 Files)', 'warn');
      return;
    }
    if (!dest.startsWith('/')) {
      this.postLine(`(upload — destination "${dest}" must be absolute)`, 'warn');
      return;
    }
    const multi = paths.length > 1;
    // Multi-file dest validation deferred to Phase 1 stat — `/home/admin`
    // (existing dir) is now accepted the same as `/home/admin/`. Phase 1
    // will reject if dest doesn't actually resolve to a directory.

    const servers = selected
      .map(n => this.ctx.config.config.servers.find(s => s.name === n))
      .filter((s): s is NonNullable<typeof s> => !!s);

    const firstName = paths[0].split(/[\\/]/).pop() ?? 'upload';
    const summary = multi
      ? `📎 upload ${paths.length} files → ${dest} on ${servers.length} server(s)`
      : `📎 upload ${firstName} → ${dest} on ${servers.length} server(s)`;
    this.postCmdEcho(`> ${summary}`);

    let okTotal = 0;
    let failTotal = 0;

    // Phase 1 — for each server: ensure connection, resolve whether `dest`
    // behaves as a directory (so `/home/admin` and `/home/admin/` both
    // mean "drop file inside"; matches GNU cp semantics), and pre-check
    // which target paths already exist. We need destIsDir resolved before
    // we know each file's final remote path, so the existence check has
    // to happen here rather than via the simpler taskRunner pattern.
    interface ServerCtx { server: typeof servers[number]; conn: SshConnection; destIsDir: boolean }
    let serverCtxs: ServerCtx[];
    try {
      serverCtxs = await Promise.all(servers.map(async server => {
        const conn = await this.ctx.registry.ensure(server);
        // Stat dest to detect dir vs file vs missing. Both single- and
        // multi-file benefit from auto-detect: `/home/admin` (existing
        // dir) should be treated identically to `/home/admin/`.
        let destIsDir = dest.endsWith('/');
        let destExists = false;
        try {
          const st = await conn.sftp.stat(dest);
          destExists = true;
          if (st.isDirectory) destIsDir = true;
        } catch (err) {
          if (!isSftpEnoent(err)) throw err;
          // ENOENT → leave defaults; treat as new file path (single-file
          // case) or fail validation (multi-file case below).
        }
        // Multi-file requires dest to be an existing directory — there's
        // no sensible interpretation of "drop N files at one file path".
        if (multi && !destIsDir) {
          throw new Error(
            `multi-file upload to ${server.name} needs ${dest} to be an existing directory ` +
            `(${destExists ? 'it is a file' : 'does not exist'})`
          );
        }
        return { server, conn, destIsDir };
      }));
    } catch (err) {
      this.postLine(`✗ upload prep failed: ${(err as Error).message}`, 'error');
      return;
    }

    // Phase 2 — dest-check overwrite confirmation. Gated on the operator's
    // safety config: `destCheck.enabled && commands.includes('upload')`,
    // matching how taskRunner.ts treats `task.type === 'upload'`. If the
    // operator disabled destCheck or omitted 'upload' from commands, we
    // respect that and skip — the auto-backup wrap (if enabled) is the
    // remaining safety net.
    const destCheckCfg = this.ctx.config.config.safety.destCheck;
    const destCheckEnabled =
      destCheckCfg.enabled && destCheckCfg.commands.includes('upload');

    if (destCheckEnabled) {
      const existingTargets = (await Promise.all(
        serverCtxs.flatMap(({ server, conn, destIsDir }) =>
          paths.map(async localPath => {
            const baseName = localPath.split(/[\\/]/).pop() ?? 'upload';
            const remotePath = destIsDir
              ? dest.replace(/\/+$/, '') + '/' + baseName
              : dest;
            try {
              await conn.sftp.stat(remotePath);
              return { server: server.name, path: remotePath };
            } catch (err) {
              // ENOENT and EACCES (treat unreadable-but-existing as
              // present, matching destCheck.findExistingDestServers
              // behaviour) — only ENOENT means "doesn't exist".
              return isSftpEnoent(err) ? null : { server: server.name, path: remotePath };
            }
          })
        )
      )).filter((e): e is { server: string; path: string } => e !== null);

      // Phase 3 — confirm overwrites with one modal. Truncate detail at 20
      // entries so a 50-server fleet doesn't blow the dialog.
      if (existingTargets.length > 0) {
        const max = 20;
        const detail = existingTargets.slice(0, max).map(e => `${e.server}: ${e.path}`).join('\n');
        const more = existingTargets.length > max ? `\n... and ${existingTargets.length - max} more` : '';
        const proceed = await vscode.window.showWarningMessage(
          `Overwrite ${existingTargets.length} existing ${existingTargets.length === 1 ? 'file' : 'files'}?`,
          { modal: true, detail: detail + more },
          'Overwrite'
        );
        if (proceed !== 'Overwrite') {
          this.postLine('(upload cancelled — destinations already exist)', 'warn');
          return;
        }
      }
    }

    // Phase 4 — actual upload, reusing the connections + destIsDir
    // resolved above so we don't re-pay the SFTP round-trips.
    await Promise.all(serverCtxs.map(async ({ server, conn, destIsDir }) => {
      try {
        for (const localPath of paths) {
          const baseName = localPath.split(/[\\/]/).pop() ?? 'upload';
          const remotePath = destIsDir
            ? dest.replace(/\/+$/, '') + '/' + baseName
            : dest;
          const data = await fs.readFile(localPath);
          // Auto-backup pre-existing dest if operator has autoBackup +
          // 'upload' enabled. buildSftpBackupCommand returns null when
          // disabled, in which case we skip straight to mkdir + write.
          const backupCmd = buildSftpBackupCommand(remotePath, this.ctx.config.config.safety.autoBackup);
          if (backupCmd) {
            const r = await runRemoteCommand(conn, backupCmd, { timeoutMs: 30_000 });
            if (r.exitCode !== 0) {
              throw new Error(`auto-backup failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`}`);
            }
          }
          const dirOnly = remotePath.slice(0, remotePath.lastIndexOf('/'));
          if (dirOnly) await conn.sftp.mkdirP(dirOnly);
          await conn.sftp.writeFile(remotePath, data);
          if (exec) {
            const r = await runRemoteCommand(
              conn,
              `chmod 0755 ${shellQuoteForRemote(remotePath)}`,
              { timeoutMs: 10_000 }
            );
            if (r.exitCode !== 0) {
              this.ctx.output.line(
                server.name,
                `⚠ chmod 0755 failed for ${remotePath}: ${r.stderr.trim() || r.stdout.trim()}`
              );
            }
          }
          this.ctx.output.line(
            server.name,
            `✓ ${remotePath} (${(data.byteLength / 1024).toFixed(1)} KB${exec ? ', mode 0755' : ''})`
          );
          okTotal++;
        }
      } catch (err) {
        // Translate ssh2's terse "Failure" into something actionable. SFTP
        // SSH_FX_FAILURE (code 4) lumps permission, disk-full, quota, and
        // "writing to a directory" together — point the operator at the
        // most likely culprits instead of leaving them stumped.
        const e = err as Error & { code?: string | number };
        const kind = classifySftpError(err);
        const codeTag = e.code !== undefined ? ` (code=${e.code})` : '';
        let humanMsg: string;
        if (kind === 'eacces') {
          humanMsg = `permission denied${codeTag} — verify ${server.user} can write to ${dest}`;
        } else if (kind === 'enoent') {
          humanMsg = `path not found${codeTag} — ${dest} or its parent dir doesn't exist`;
        } else if (e.message === 'Failure') {
          humanMsg =
            `SFTP failure${codeTag} — likely permission, quota, disk full, or dest is a directory ` +
            `(try \`ls -ld ${dest}\` and \`df -h\` on the server)`;
        } else {
          humanMsg = `${e.message}${codeTag}`;
        }
        this.ctx.output.line(server.name, `✗ upload failed: ${humanMsg}`);
        failTotal++;
      }
    }));

    this.postCmdEcho(
      `(upload done: ${okTotal} succeeded${failTotal ? `, ${failTotal} failed` : ''})`
    );
  }

  /** SFTP-read a remote file and place its contents on the clipboard. */
  private async handleCopyContent(server: string, remotePath: string): Promise<void> {
    const conn = this.ctx.registry.get(server);
    if (!conn) {
      this.postLine(`✗ ${server}: not connected`, 'error');
      return;
    }
    try {
      // Stat first — copying a 1 GB file to clipboard would freeze the
      // extension host and likely OOM. Use the same guard as click-to-
      // open: hard cap from `maxFileDownloadSize`, soft warning above
      // `maxFileOpenSize` (clipboard content is editor-bound in spirit).
      const preStat = await conn.sftp.stat(remotePath);
      if (!await this.guardFileOpen(server, remotePath, preStat.size, 'open')) return;
      const data = await conn.sftp.readFile(remotePath);
      // Copy as UTF-8; binary files turn into mojibake but the user asked
      // for "copy content" — they get what's there.
      await vscode.env.clipboard.writeText(data.toString('utf-8'));
      this.postLine(`(copied ${remotePath} from ${server} to clipboard — ${(data.byteLength / 1024).toFixed(1)} KB)`);
    } catch (err) {
      this.postLine(`✗ copy failed: ${(err as Error).message}`, 'error');
    }
  }

  /** Download a remote file via the mirror system. Reveals the local copy
   *  in the OS file explorer once the download finishes. */
  private async handleDownloadFile(server: string, remotePath: string): Promise<void> {
    try {
      const entry = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading ${server}:${remotePath}…` },
        () => this.ctx.mirror.download(server, remotePath)
      );
      const action = await vscode.window.showInformationMessage(
        `SSH Fleet: downloaded to ${entry.localPath}`,
        'Reveal in OS', 'Open'
      );
      if (action === 'Reveal in OS') {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(entry.localPath));
      } else if (action === 'Open') {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.localPath));
        await vscode.window.showTextDocument(doc);
      }
    } catch (err) {
      this.postLine(`✗ download failed: ${(err as Error).message}`, 'error');
    }
  }

  /** Tar.gz a remote directory and download the archive. When called
   *  from the multi-server handler, `skipConfirm` is true (caller has
   *  already shown a combined modal listing all affected servers). */
  private async handleDownloadTar(
    server: string,
    remoteDir: string,
    skipConfirm = false
  ): Promise<void> {
    const conn = this.ctx.registry.get(server);
    if (!conn) {
      this.postLine(`✗ ${server}: not connected`, 'error');
      return;
    }
    // Depth guard: refuse to archive `/` or shallow dirs like `/tmp`,
    // `/etc`, `/var` — they routinely hold GB of unrelated data and an
    // operator landing on them is almost always a misclick. Override
    // via `settings.archiveMinDepth` (0 = disabled).
    const depth = remoteDir.split('/').filter(Boolean).length;
    const minDepth = this.ctx.config.config.settings.archiveMinDepth;
    if (depth < minDepth) {
      this.postLine(
        `✗ archive blocked: ${remoteDir} is too shallow (depth ${depth} < min ${minDepth}). ` +
        `Pick a deeper directory or lower 'settings.archiveMinDepth' in your config.`,
        'error'
      );
      return;
    }
    // Always-on confirmation modal — archiving is potentially expensive
    // (RAM, disk, time, network) and right-clicking the wrong row is
    // easy. Run BEFORE the zip-probe round-trip so cancel costs zero
    // SSH calls. `{ modal: true }` auto-injects Cancel; the explicit
    // 'Archive' button is the affirmative. Skipped when the caller
    // (multi-server path) has already confirmed.
    if (!skipConfirm) {
      const proceed = await vscode.window.showWarningMessage(
        `Archive ${server}:${remoteDir}?`,
        {
          modal: true,
          detail: 'This compresses the directory on the remote and downloads the archive locally. Large directories may take minutes and consume significant disk/RAM on both sides.'
        },
        'Archive'
      );
      if (proceed !== 'Archive') return;
    }
    // Decide archive format: settings.archiveFormat = 'auto' | 'zip' | 'tar.gz'.
    // 'auto' probes for zip availability on the remote, falls back to tar.gz.
    const formatPref = this.ctx.config.config.settings.archiveFormat;
    let useZip = formatPref === 'zip';
    if (formatPref === 'auto') {
      const probe = await runRemoteCommand(
        conn, 'command -v zip >/dev/null 2>&1 && echo y', { timeoutMs: 5_000 }
      );
      useZip = probe.exitCode === 0 && probe.stdout.trim() === 'y';
    }
    const ext = useZip ? 'zip' : 'tar.gz';
    const baseName = remoteDir === '/' ? 'root' : path.basename(remoteDir);
    const stagingName = `_ssh-fleet_${Date.now()}_${baseName}.${ext}`;
    const remoteTar = `/tmp/${stagingName}`;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Archiving ${server}:${remoteDir} → ${baseName}.${ext}…` },
        async (progress) => {
          const parent = remoteDir === '/' ? '/' : remoteDir.slice(0, remoteDir.lastIndexOf('/')) || '/';
          const base = remoteDir === '/' ? '/' : remoteDir.split('/').filter(Boolean).pop() ?? '.';
          // For zip we cd into parent so paths inside the archive are relative;
          // tar has -C flag for the same effect. Both produce relative paths.
          const cmd = useZip
            ? `cd ${shellQuoteForRemote(parent)} && zip -qr ${shellQuoteForRemote(remoteTar)} ${shellQuoteForRemote(base)}`
            : `tar -czf ${shellQuoteForRemote(remoteTar)} -C ${shellQuoteForRemote(parent)} ${shellQuoteForRemote(base)}`;
          // Background poll: every 3s, stat the staging archive and post
          // its current size into the progress UI. Lets the operator see
          // "8.2 MB" growing while a big tar runs, vs. a frozen-looking
          // notification. Stops automatically when the runRemoteCommand
          // promise resolves (the loop checks `done`).
          let done = false;
          const fmtMB = (n: number): string =>
            n >= 1024 * 1024 * 1024
              ? `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
              : `${(n / 1024 / 1024).toFixed(1)} MB`;
          const pollSize = async (): Promise<void> => {
            while (!done) {
              await new Promise(r => setTimeout(r, 3_000));
              if (done) break;
              try {
                const st = await runRemoteCommand(
                  conn, `stat -c %s ${shellQuoteForRemote(remoteTar)} 2>/dev/null || stat -f %z ${shellQuoteForRemote(remoteTar)} 2>/dev/null`,
                  { timeoutMs: 3_000 }
                );
                const bytes = parseInt(st.stdout.trim(), 10);
                if (Number.isFinite(bytes) && bytes > 0) {
                  progress.report({ message: `${fmtMB(bytes)} so far…` });
                }
              } catch { /* ignore poll failures */ }
            }
          };
          void pollSize();
          const r = await runRemoteCommand(conn, cmd, { timeoutMs: 120_000 });
          done = true;
          if (r.exitCode !== 0) {
            throw new Error(`${useZip ? 'zip' : 'tar'} failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
          }
          const entry = await this.ctx.mirror.download(server, remoteTar);
          // Move to a clean local name (untrack from mirror — archives are
          // point-in-time snapshots, not push/pull targets).
          const ts = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
          const finalLocalPath = path.join(this.ctx.mirror.rootPath, server, `${baseName}_${ts}.${ext}`);
          await fs.mkdir(path.dirname(finalLocalPath), { recursive: true });
          await fs.rename(entry.localPath, finalLocalPath);
          await this.ctx.mirror.untrack(entry.localPath);
          const note = formatPref === 'auto' && !useZip
            ? ' [zip not installed on remote; used tar.gz]' : '';
          this.postLine(`(${ext} downloaded → ${finalLocalPath}${note})`);
          // Best-effort cleanup of the remote tmp archive.
          try {
            await runRemoteCommand(conn, `rm -f ${shellQuoteForRemote(remoteTar)}`, { timeoutMs: 10_000 });
          } catch { /* ignore */ }
        }
      );
    } catch (err) {
      // Even on failure, try to clean up the tmp archive on the remote.
      try {
        await runRemoteCommand(conn, `rm -f ${shellQuoteForRemote(remoteTar)}`, { timeoutMs: 10_000 });
      } catch { /* ignore */ }
      this.postLine(`✗ ${ext} failed: ${(err as Error).message}`, 'error');
    }
  }

  /**
   * Tar.gz a remote directory on EACH currently-selected server and
   * download all the archives locally. One combined confirm at the top
   * (the operator sees the full server list before any archive starts);
   * each server's archive lands under its per-server mirror folder so
   * basenames don't collide.
   *
   * Runs in parallel via Promise.allSettled — one server's failure
   * doesn't block the others, and per-server outcomes still log via
   * `handleDownloadTar`'s internal `postLine` calls.
   */
  private async handleDownloadTarMany(remoteDir: string): Promise<void> {
    const selected = this.ctx.selection.servers;
    if (selected.length === 0) {
      this.postLine('(no servers selected)', 'warn');
      return;
    }
    if (!this.enforceCap(selected.length, 'Archive from many')) return;
    // Depth guard once at the multi level — same path across servers,
    // so checking once gives the operator earlier feedback than
    // surfacing it N times in postLine after the modal.
    const depth = remoteDir.split('/').filter(Boolean).length;
    const minDepth = this.ctx.config.config.settings.archiveMinDepth;
    if (depth < minDepth) {
      void vscode.window.showWarningMessage(
        `Archive blocked: ${remoteDir} is too shallow (depth ${depth} < min ${minDepth}).`,
        { modal: true, detail: `Pick a deeper directory or lower 'settings.archiveMinDepth' in your config.` }
      );
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Archive ${remoteDir} from ${selected.length} servers?`,
      {
        modal: true,
        detail: `Servers: ${selected.join(', ')}\n\nThis compresses the directory on each remote and downloads ${selected.length} archive(s) locally. May take minutes per server.`
      },
      'Archive'
    );
    if (ok !== 'Archive') return;
    const results = await Promise.allSettled(
      selected.map(server => this.handleDownloadTar(server, remoteDir, true))
    );
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) {
      void vscode.window.showWarningMessage(
        `SSH Fleet: archive completed on ${selected.length - failed}/${selected.length} server(s) — see Console for failures.`
      );
    } else {
      void vscode.window.showInformationMessage(
        `SSH Fleet: archived from ${selected.length} server(s).`
      );
    }
  }

  /** Delete a remote file or directory (`rm -f` / `rm -rf`). The webview
   *  has already shown a `confirm()` dialog before posting; this layer
   *  re-confirms via a modal in case the click came from elsewhere. */
  /**
   * Download the same remote path from EACH currently-selected server.
   * Each server's file lands in its own subfolder under the workspace
   * mirror dir so basename collisions don't clobber. Always confirms
   * since the list of affected servers + the local writes are non-trivial.
   */
  private async handleDownloadFileMany(remotePath: string): Promise<void> {
    const selected = this.ctx.selection.servers;
    if (selected.length === 0) {
      this.postLine('(no servers selected)', 'warn');
      return;
    }
    if (!this.enforceCap(selected.length, 'Download from many')) return;
    const ok = await vscode.window.showWarningMessage(
      `Download ${remotePath} from ${selected.length} servers?`,
      { modal: true, detail: selected.join(', ') },
      'Download'
    );
    if (ok !== 'Download') return;

    const results = await Promise.allSettled(
      selected.map(server => this.ctx.mirror.download(server, remotePath))
    );
    let okCount = 0;
    const localPaths: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const server = selected[i];
      if (r.status === 'fulfilled') {
        okCount++;
        localPaths.push(r.value.localPath);
        this.ctx.output.line(server, `✓ downloaded → ${r.value.localPath}`);
      } else {
        this.ctx.output.line(server, `✗ download failed: ${(r.reason as Error).message}`);
      }
    }
    if (okCount > 0) {
      const action = await vscode.window.showInformationMessage(
        `SSH Fleet: downloaded from ${okCount}/${selected.length} server(s).`,
        'Reveal first in OS'
      );
      if (action === 'Reveal first in OS' && localPaths[0]) {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(localPaths[0]));
      }
    }
  }

  /**
   * Delete the same remote path on EACH currently-selected server.
   * Always confirms with the full server list visible in the modal
   * `detail` so the operator sees what they're about to wipe out.
   */
  private async handleDeleteMany(remotePath: string, isDir: boolean): Promise<void> {
    const selected = this.ctx.selection.servers;
    if (selected.length === 0) {
      this.postLine('(no servers selected)', 'warn');
      return;
    }
    if (!this.enforceCap(selected.length, 'Delete on many')) return;
    const ok = await vscode.window.showWarningMessage(
      `Delete ${isDir ? 'directory (recursively)' : 'file'} on ${selected.length} servers?`,
      {
        modal: true,
        detail: `${remotePath}\n\nServers: ${selected.join(', ')}\n\n${isDir ? 'rm -rf' : 'rm -f'} — this cannot be undone.`
      },
      'Delete'
    );
    if (ok !== 'Delete') return;

    const rawCmd = (isDir ? 'rm -rf ' : 'rm -f ') + shellQuoteForRemote(remotePath);
    const cmd = wrapBackup(rawCmd, this.ctx.config.config.safety.autoBackup);
    const results = await Promise.allSettled(
      selected.map(async server => {
        const conn = this.ctx.registry.get(server);
        if (!conn) throw new Error('not connected');
        return runRemoteCommand(conn, cmd, { timeoutMs: 30_000 });
      })
    );
    let okCount = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const server = selected[i];
      if (r.status === 'fulfilled' && r.value.exitCode === 0) {
        okCount++;
        this.ctx.output.line(server, `✓ deleted ${remotePath}`);
      } else if (r.status === 'fulfilled') {
        this.ctx.output.line(
          server,
          `✗ delete failed (exit ${r.value.exitCode}): ${r.value.stderr.trim() || r.value.stdout.trim()}`
        );
      } else {
        this.ctx.output.line(server, `✗ delete error: ${(r.reason as Error).message}`);
      }
    }
    if (okCount < selected.length) {
      void vscode.window.showWarningMessage(
        `SSH Fleet: delete completed on ${okCount}/${selected.length} server(s) — see Console for failures.`
      );
    }
  }

  private async handleDelete(server: string, remotePath: string, isDir: boolean): Promise<void> {
    const conn = this.ctx.registry.get(server);
    if (!conn) {
      this.postLine(`✗ ${server}: not connected`, 'error');
      return;
    }
    const proceed = await vscode.window.showWarningMessage(
      `Delete ${isDir ? 'directory (recursively)' : 'file'} on ${server}?`,
      { modal: true, detail: `${remotePath}\n\n${isDir ? 'rm -rf' : 'rm -f'} — this cannot be undone.` },
      'Delete'
    );
    if (proceed !== 'Delete') return;
    // Build the rm and route through wrapBackup so right-click Delete
    // honours the same safety net as typed broadcasts. Without this the
    // operator's autoBackup config silently doesn't apply here. wrapBackup
    // is a no-op when `safety.autoBackup.enabled` is false, so behaviour
    // is unchanged for operators who've turned backup off.
    const rawCmd = (isDir ? 'rm -rf ' : 'rm -f ') + shellQuoteForRemote(remotePath);
    const cmd = wrapBackup(rawCmd, this.ctx.config.config.safety.autoBackup);
    const r = await runRemoteCommand(conn, cmd, { timeoutMs: 30_000 });
    if (r.exitCode === 0) {
      this.ctx.output.line(server, `✓ deleted ${remotePath}`);
    } else {
      this.ctx.output.line(server, `✗ delete failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }

  /**
   * Public entry point used by ScheduleStore tick callbacks. Runs the saved
   * command on the saved server set, regardless of current TreeView selection.
   */
  async dispatchScheduled(task: ScheduledTask): Promise<void> {
    // Schedule targets are RESOLVED AT TICK TIME from the live registry —
    // every currently-connected server gets the command. This means newly
    // connected servers join the rotation automatically, and disconnected
    // ones drop out without any explicit reconfiguration. (Selection at
    // start-time is intentionally not used.)
    const connected = this.ctx.registry.list().filter(c => c.state === 'connected');
    const servers = connected
      .map(c => this.ctx.config.config.servers.find(s => s.name === c.server.name))
      .filter((s): s is NonNullable<typeof s> => !!s);
    // Always record the tick — even no-server skips count as "schedule is
    // alive" so operators reading the schedule indicator see the heartbeat.
    void this.ctx.schedule.recordTick(task.configName);
    if (servers.length === 0) {
      // Tick when nothing is connected — quiet skip; no point spamming the
      // log every interval. The schedule itself stays armed.
      return;
    }
    // Defensive cap check at tick time: if the connected fleet grows past
    // the cap (e.g. operator connected 50 servers since arming the
    // schedule), refuse the tick. The schedule stays armed; on the next
    // tick the operator may have disconnected some.
    if (!this.enforceCap(servers.length, 'Scheduled run')) return;
    // Silent mode: the tick runs but doesn't echo header / progress / clean
    // exits. Failures STILL print so operators don't lose visibility on
    // problems. The schedule-status indicator still shows lastTickAt.
    const silent = !!task.silent;
    if (!silent) {
      this.postCmdEcho(`> ${task.command}  (scheduled tick)`);
      this.postToWeb({
        type: 'runStarted',
        label: `scheduled "${task.command}"`,
        serverNames: servers.map(s => s.name)
      });
      this.ctx.output.header(`▶ Scheduled run on ${servers.length} server(s): ${task.command}`);
    }

    let doneCount = 0, failedCount = 0;
    const total = servers.length;
    await Promise.all(servers.map(async server => {
      try {
        const conn = await this.ctx.registry.ensure(server);
        const result = await runRemoteCommand(conn, task.command, {
          timeoutMs: defaultTimeoutMs(),
          onStdout: chunk => { if (!silent) this.ctx.output.stream(server.name, chunk, 'stdout'); },
          onStderr: chunk => { if (!silent) this.ctx.output.stream(server.name, chunk, 'stderr'); }
        });
        if (result.exitCode === 0) {
          doneCount += 1;
        } else {
          failedCount += 1;
          // Surface failures even in silent mode.
          this.ctx.output.line(server.name, `✗ scheduled "${task.command}" exit ${result.exitCode} (${(result.durationMs / 1000).toFixed(1)}s)`);
        }
      } catch (err) {
        this.ctx.output.line(server.name, `✗ scheduled "${task.command}" error: ${(err as Error).message}`);
        failedCount += 1;
      }
      if (!silent) {
        this.postToWeb({
          type: 'runProgress', doneCount, failedCount, totalCount: total
        });
      }
    }));
    if (!silent) {
      this.ctx.output.header(`■ Scheduled done: ${doneCount}/${total} succeeded${failedCount ? `, ${failedCount} failed` : ''}`);
      this.postToWeb({
        type: 'runDone',
        label: `scheduled "${task.command}"`,
        ok: doneCount,
        failed: failedCount
      });
    }
    // (recordTick already fired at the top of this method, covering both
    // the no-servers-connected skip and successful runs uniformly so the
    // schedule indicator shows the true tick heartbeat.)
  }

  private async replyScheduleStatus(): Promise<void> {
    const cfgFull = await this.ctx.workspace.resolveActiveConfig();
    const name = cfgFull ? path.basename(cfgFull) : '';
    const t = this.ctx.schedule.get(name);
    const msg: ExtToWebSingleMessage = {
      type: 'scheduleStatus',
      intervalSec: t?.intervalSec ?? 60,
      command: t?.command ?? '',
      serverNames: t?.serverNames ?? [],
      enabled: t?.enabled ?? false,
      silent: t?.silent ?? false
    };
    if (t?.lastTickAt !== undefined) msg.lastTickAt = t.lastTickAt;
    this.postToWeb(msg);
  }

  /**
   * Patch the active config YAML's `aliases:` block in place, preserving
   * comments and surrounding fields via the YAML library's Document API.
   */
  private async saveAliasesToActiveConfig(aliases: Record<string, string>): Promise<void> {
    const cfgFull = await this.ctx.workspace.resolveActiveConfig();
    if (!cfgFull) {
      this.postLine('(no active config to write aliases into — open a config first)', 'warn');
      return;
    }
    const text = await fs.readFile(cfgFull, 'utf-8');
    const doc = YAML.parseDocument(text);
    const map = new YAML.YAMLMap();
    for (const [k, v] of Object.entries(aliases)) {
      map.set(k, v);
    }
    if (Object.keys(aliases).length === 0) {
      doc.delete('aliases');
    } else {
      doc.set('aliases', map);
    }
    await fs.writeFile(cfgFull, doc.toString({ lineWidth: 0 }), 'utf-8');
    this.postLine(`(saved ${Object.keys(aliases).length} alias(es) to ${path.basename(cfgFull)})`);
  }

  dispose(): void {
    if (this.postFlushTimer) {
      clearTimeout(this.postFlushTimer);
      this.postFlushTimer = undefined;
    }
    // Don't bother flushing the queue — the webview is going away.
    this.postQueue = [];
    for (const s of this.subs) s.dispose();
    SshFleetWebviewPanel.current = undefined;
    SshFleetWebviewPanel.openStateEmitter.fire();
  }

  /**
   * Single funnel for ALL webview-bound messages. Coalesces into a
   * timer-flushed batch wrapped in `outputBatch`. Preserves FIFO order
   * across all message types so a `cmd` echo can't end up after the
   * stream lines that belong to it. A hard length cap forces an
   * immediate flush so memory stays bounded if the panel is hidden
   * (timer still fires, but rAF on the receiving end doesn't).
   */
  private postToWeb(msg: ExtToWebSingleMessage): void {
    this.postQueue.push(msg);
    if (this.postQueue.length >= SshFleetWebviewPanel.POST_FLUSH_HARD_CAP) {
      this.flushPostQueue();
      return;
    }
    if (!this.postFlushTimer) {
      this.postFlushTimer = setTimeout(() => this.flushPostQueue(), SshFleetWebviewPanel.POST_FLUSH_MS);
    }
  }

  private flushPostQueue(): void {
    if (this.postFlushTimer) {
      clearTimeout(this.postFlushTimer);
      this.postFlushTimer = undefined;
    }
    if (this.postQueue.length === 0) return;
    const batch = this.postQueue;
    this.postQueue = [];
    // Single-item: skip the wrapper (saves an array on the receiving side).
    if (batch.length === 1) {
      void this.panel.webview.postMessage(batch[0] as ExtToWebMessage);
    } else {
      void this.panel.webview.postMessage({ type: 'outputBatch', items: batch } as ExtToWebMessage);
    }
  }
}

/** POSIX shell-safe single-quote a string. Used for chmod targets after
 *  upload — the remote always runs a Unix shell. */
function shellQuoteForRemote(s: string): string {
  if (/^[A-Za-z0-9_./@:%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Common binary-file extensions where opening in the editor produces
 *  mojibake or stalls VSCode's renderer. Cheap heuristic — extension-
 *  based, no SFTP-side sniff (which would need to download first). */
const BINARY_EXTENSIONS = new Set([
  // Compiled artefacts
  '.so', '.dll', '.exe', '.o', '.a', '.lib', '.obj', '.bin',
  '.class', '.jar', '.war', '.ear',
  // Archives
  '.tar', '.gz', '.bz2', '.xz', '.7z', '.zip', '.rar', '.tgz', '.tbz2',
  // Disk images / packages
  '.iso', '.img', '.dmg', '.deb', '.rpm', '.pkg', '.msi',
  // Images / docs
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico',
  '.pdf', '.psd', '.ai',
  // Media
  '.mp4', '.mp3', '.mov', '.avi', '.mkv', '.flac', '.wav', '.ogg',
  // Data files
  '.db', '.sqlite', '.sqlite3', '.pyc', '.pyo'
]);

function isLikelyBinary(remotePath: string): boolean {
  const dot = remotePath.lastIndexOf('.');
  if (dot < 0) return false;
  return BINARY_EXTENSIONS.has(remotePath.slice(dot).toLowerCase());
}

function defaultTimeoutMs(): number {
  const sec = vscode.workspace.getConfiguration().get<number>('ssh-fleet.defaultTimeout') ?? 60;
  return sec > 0 ? sec * 1000 : 0;
}

function warningLabelFor(
  server: { name: string; host: string },
  cfg: { safety: { serverWarnPatterns: { pattern: string; label: string; color: string }[] } }
): { label: string; color: string } | undefined {
  for (const p of cfg.safety.serverWarnPatterns) {
    if (globMatch(p.pattern, server.name) || globMatch(p.pattern, server.host)) {
      return { label: p.label, color: p.color };
    }
  }
  return undefined;
}
