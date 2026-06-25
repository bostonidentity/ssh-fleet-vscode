/**
 * Typed message protocol between the extension host and the webview client.
 *
 * The webview now owns: output rendering, cwd breadcrumb, command input,
 *   right-click menus on output lines, clickable paths.
 *
 * The webview does NOT own: server / task lists. Those live in the native
 *   TreeView; we only push the resulting selection summary down to the panel.
 */

export type OutputKind = 'stdout' | 'stderr' | 'header' | 'info' | 'warn' | 'error' | 'cmd' | 'cmdWarn';

/** Snapshot pushed to the webview on init / state changes. */
export interface PanelStateSnapshot {
  // Selection summary — actual sets live in extension's SelectionState.
  selectedCount: number;
  totalServers: number;
  connectedCount: number;

  // Virtual cwd summary across selected servers.
  cwdCommon?: string;
  cwdMixed: boolean;
  /** Per-server cwd snapshot so the webview can resolve `ls -l` filenames. */
  cwdByServer: Record<string, string>;

  bookmarks: string[];

  workspaceRoot?: string;
  activeConfig?: string;
  availableConfigs: string[];

  /**
   * Per-server warn label (if any) so tab bar / output prefix can colour
   * a server's tab red etc. Keyed by server name; absent = no warning tag.
   */
  warnByServer: Record<string, { label: string; color: string }>;

  /** Visual hint reflecting safety.autoBackup.enabled — shown next to cwd. */
  backupEnabled: boolean;
  /**
   * Aggregated backup-dir probe status across selected/connected servers.
   * 'ok' when every probed server's backupDir is writable; 'failed' when at
   * least one probe failed (gray badge + tooltip lists offenders);
   * 'unchecked' when nothing has been probed yet (e.g. no connected server).
   * Only meaningful when `backupEnabled` is true.
   */
  backupHealth: { overall: 'ok' | 'failed' | 'unchecked'; failedDetail?: string };
  /** Persisted UI prefs (PrefsStore). Webview reflects these on init. */
  hideTimestamps: boolean;
  deselectAfterRun: boolean;

  /** Filter state — webview renders an always-visible filter row. */
  availableEnvs: string[];
  availableModules: string[];
  filterEnvs: string[];
  filterModules: string[];
  filterText: string;

  /** Aliases (name → expansion) so the cmd input can offer auto-suggest. */
  aliases: Record<string, string>;

  /** Default listing command (e.g. "ls -ltr") from `settings.lsCommand`. */
  lsCommand: string;

  /**
   * Configured `safety.autoBackup.backupDir` so the webview can offer a
   * "click the 🛡 backup badge to ls the backup dir" affordance without
   * round-tripping config through messages. Undefined when autoBackup
   * is disabled.
   */
  backupDir?: string;
  /**
   * Mirror of `settings.archiveMinDepth` so the webview can gray out
   * the "Download as archive…" item for paths it would reject anyway.
   */
  archiveMinDepth: number;
  /** Mirror of `settings.shortenHostnames` — if true, the line-prefix
   *  `[server-name]` shortens FQDNs to their first label (full name kept
   *  as a hover tooltip). Default true; per-build setting from config. */
  shortenHostnames: boolean;
  /** Operator's persisted ls-flags override (e.g. `"ltrah"`), or `null`
   *  if no override has been set. Webview seeds the dropdown checkboxes
   *  from this on init. The override survives workdir reload because
   *  it's stored in `<workdir>/.ssh-fleet-state.json` — useful in
   *  environments where the user profile resets between sessions but
   *  the workdir is on persistent storage. */
  lsFlagsOverride: string | null;
}

// --- extension → webview ---

/** Single (non-batch) extension → webview message. */
export type ExtToWebSingleMessage =
  | { type: 'init'; state: PanelStateSnapshot }
  | { type: 'state'; state: PanelStateSnapshot }
  | { type: 'output'; kind: OutputKind; serverName?: string; text: string; ts?: number }
  | { type: 'outputClear' }
  | { type: 'runStarted'; label: string; serverNames: string[] }
  | { type: 'runProgress'; doneCount: number; failedCount: number; totalCount: number }
  | { type: 'runDone'; label: string; ok: number; failed: number }
  | { type: 'scheduleStatus'; intervalSec: number; command: string; serverNames: string[]; enabled: boolean; silent: boolean; lastTickAt?: number }
  | { type: 'aliasesList'; aliases: Record<string, string> }
  /** Reply to `uploadPickFiles` — `paths` is the absolute local fsPath of
   *  each picked file. Empty array if the user cancelled. */
  | { type: 'uploadFilesPicked'; paths: string[]; names: string[] }
  /** Reply to `pathComplete` — readdir results for tab completion. `partial`
   *  echoes the request so a stale response (operator kept typing) can be
   *  detected and dropped by the webview. `matches[].name` is just the
   *  basename; `isDir` lets the renderer append `/` for directories. */
  | { type: 'pathCompleteResult'; reqId: number; partial: string; matches: { name: string; isDir: boolean }[] }
  /** Reply to `commandComplete` — command-name candidates from
   *  `compgen -c` / PATH scan. `isDir` is always false here. */
  | { type: 'commandCompleteResult'; reqId: number; prefix: string; matches: string[] };

export type ExtToWebMessage =
  | ExtToWebSingleMessage
  /** Coalesced batch wrapper. Used by the extension to amortise the
   *  postMessage IPC cost when many output lines arrive in a short
   *  window. The webview unpacks `items` and dispatches each as if it
   *  had been received on its own. */
  | { type: 'outputBatch'; items: ExtToWebSingleMessage[] };

// --- webview → extension ---

export type WebToExtMessage =
  | { type: 'ready' }
  /**
   * Run an arbitrary command on the currently-selected servers.
   * `source` distinguishes operator-typed input (Ad-hoc field + Enter)
   * from synthesized commands generated by navigation clicks
   * (breadcrumb, Home button, path-link in output, custom ls Run, etc.).
   * Only `'adhoc'` commands belong in the command-history surfaces
   * (arrow-key recall, "Run from History" command palette) — navigation
   * commands are operator clicks, not commands the operator typed.
   */
  | { type: 'runCommand'; command: string; source: 'adhoc' | 'navigation' }
  | { type: 'runSpecial'; line: string }
  | { type: 'cancelRun' }
  | { type: 'pathClick'; server: string; path: string }
  | { type: 'pathOpen'; server: string; path: string }
  | { type: 'bookmarkAdd'; path: string }
  | { type: 'bookmarkRemove'; path: string }
  | { type: 'lsFlagsChanged'; flags: string }
  | { type: 'openConfig' }
  | { type: 'reloadConfig' }
  | { type: 'switchActiveConfig'; configName: string }
  | { type: 'scheduleGet' }
  | { type: 'scheduleStart'; intervalSec: number; command: string; silent?: boolean }
  | { type: 'scheduleStop' }
  | { type: 'aliasesGet' }
  | { type: 'aliasesSave'; aliases: Record<string, string> }
  | { type: 'prefsSet'; hideTimestamps?: boolean; deselectAfterRun?: boolean }
  | { type: 'filterSet'; envs?: string[]; modules?: string[]; text?: string }
  | { type: 'filterClear' }
  /** User clicked the inline "📎 Files" button — extension shows the
   *  native file picker and replies with `uploadFilesPicked`. */
  | { type: 'uploadPickFiles' }
  /** User clicked the inline "Upload" button with values already filled in
   *  on the row. `paths` are absolute local fsPaths from the prior pick. */
  | { type: 'uploadAdhoc'; paths: string[]; dest: string; exec: boolean }
  /** Read a remote text file via SFTP and place its contents on the
   *  operator's clipboard. Powers the "Copy file content" ctx-menu item. */
  | { type: 'pathCopyContent'; server: string; path: string }
  /** Open the same path on every ticked server (multi-server view). */
  | { type: 'pathOpenOnSelected'; path: string }
  /** Run `cd <path> && <lsCommand>` on every ticked server. The webview
   *  knows the target is a directory (e.g. clicking the 🛡 backup badge),
   *  so we want list-directory semantics, not the file-download path
   *  that `pathOpenOnSelected → :se` takes. */
  | { type: 'lsRemoteDir'; path: string }
  /** Download a remote path to the operator's machine via the mirror. */
  | { type: 'pathDownload'; server: string; path: string }
  /** Download a remote DIRECTORY by tar.gz'ing it on the remote first. */
  | { type: 'pathDownloadTar'; server: string; path: string }
  /** Delete a remote file or directory. Webview already confirmed. */
  | { type: 'pathDelete'; server: string; path: string; isDir: boolean }
  /** Download the same remote path from each currently-selected server.
   *  Files land in per-server subfolders to avoid name collisions. */
  | { type: 'pathDownloadMany'; path: string }
  /** Tar.gz a remote DIRECTORY on each currently-selected server and
   *  download the resulting archives. */
  | { type: 'pathDownloadTarMany'; path: string }
  /** Delete a remote file/directory on each currently-selected server.
   *  Extension owns the modal confirm because we need the full server
   *  list in the modal `detail` field. */
  | { type: 'pathDeleteMany'; path: string; isDir: boolean }
  /** Ask the extension host to surface a VSCode toast. Used when the
   *  webview wants a native notification (e.g. "select a server first"
   *  on the 🛡 backup badge click) — webview-internal alerts look out
   *  of place, and we already have host privilege to call window.show*. */
  | { type: 'notify'; level: 'info' | 'warn' | 'error'; text: string }
  /** Tab-completion request. Webview supplies a partial path (the token
   *  before the cursor), the host SFTP-readdirs the parent on the
   *  user-picked server (first selected), filters by prefix, and
   *  returns matches via `pathCompleteResult`. Multi-server scenario
   *  picks the first selected — operator can ESC if it doesn't fit. */
  | { type: 'pathComplete'; server: string; partial: string; reqId: number }
  /** Tab on the first token at command position. Host runs `compgen -c`
   *  on the picked server and returns matching command names (PATH
   *  binaries + builtins + aliases + functions). Reuses the path-
   *  suggest dropdown UI in the webview. */
  | { type: 'commandComplete'; server: string; prefix: string; reqId: number };

export const PROTOCOL_VERSION = 2;
