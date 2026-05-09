import * as vscode from 'vscode';
import type { ConfigStore } from '../config/loader.js';
import type { SecretStore } from '../secrets/store.js';
import type { ConnectionRegistry } from '../ssh/connection.js';
import type { HostKeyStore } from '../ssh/hostKeys.js';
import type { OutputManager } from '../output/channel.js';
import type { CommandHistory } from '../features/history.js';
import type { BookmarkStore } from '../features/bookmarks.js';
import type { MirrorStore } from '../features/mirror.js';
import type { ServerTreeProvider } from '../views/serverTreeProvider.js';
import type { Workspace } from '../workspace.js';
import type { SelectionState } from '../state/selection.js';
import type { VirtualCwdState } from '../state/cwd.js';
import type { ScheduleStore } from '../state/schedule.js';
import type { ServerFilterState } from '../state/serverFilter.js';
import type { PrefsStore } from '../state/prefs.js';
import type { BackupHealthState } from '../state/backupHealth.js';
import type { WorkdirStateStore } from '../state/workdirState.js';

export interface CommandContext {
  extension: vscode.ExtensionContext;
  config: ConfigStore;
  secrets: SecretStore;
  registry: ConnectionRegistry;
  hostKeys: HostKeyStore;
  workspace: Workspace;
  output: OutputManager;
  history: CommandHistory;
  bookmarks: BookmarkStore;
  mirror: MirrorStore;
  tree: ServerTreeProvider;
  selection: SelectionState;
  cwd: VirtualCwdState;
  schedule: ScheduleStore;
  serverFilter: ServerFilterState;
  prefs: PrefsStore;
  backupHealth: BackupHealthState;
  workdirState: WorkdirStateStore;
  /** Map of active Terminal instances per server name. */
  terminals: Map<string, vscode.Terminal>;
}
