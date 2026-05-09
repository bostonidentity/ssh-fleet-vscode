import * as vscode from 'vscode';
import type { CommandContext } from './context.js';
import {
  cmdConnect,
  cmdDisconnect,
  cmdDisconnectAll,
  cmdConnectSelected,
  cmdDisconnectSelected,
  cmdUpdateCredential,
  cmdCopyHost,
  cmdReconnectAll
} from './connect.js';
import { cmdOpenTerminal } from './openTerminal.js';
import { cmdRunCommand, cmdRunOnGroup, cmdRunTask, cmdRunTaskByName, cmdRunFromHistory } from './runCommand.js';
import { cmdInsertBookmark } from './bookmarks.js';
import { cmdOpenConfig, cmdReloadConfig, cmdShowConnected } from './config.js';
import { cmdAddServer } from './addServer.js';
import { cmdOpenRemoteFile, cmdMountRemoteFolder, cmdBrowseRemote } from './remoteFiles.js';
import {
  cmdDownloadRemoteFile,
  cmdPushToRemote,
  cmdPullFromRemote,
  cmdUntrackMirror,
  cmdShowMirroredFiles,
  cmdRevealMirrorFolder,
  cmdUploadLocalFile,
  cmdUploadToManyServers,
  cmdDownloadFromManyServers
} from './mirror.js';
import { cmdManageKnownHosts } from './hostKeys.js';
import { cmdOpenTasksFolder, cmdOpenTaskFile, cmdNewTaskFile } from './tasks.js';
import { cmdFilterByEnv, cmdFilterByModule, cmdFilterByText, cmdFilterClear } from './filter.js';
import { cmdOpenOnSelected, cmdSaveAllToServers, cmdDiffSiblings } from './multiEdit.js';
import {
  cmdCopySelectedHosts,
  cmdSaveSelectedTasksAsFile,
  cmdSelectAllTasks,
  cmdDeselectAllTasks,
  cmdToggleDeselectAfterRun,
  cmdSelectTaskFiles
} from './helpers.js';
import { cmdTaskMoveUp, cmdTaskMoveDown } from './taskOrder.js';
import {
  cmdSetupWorkspace,
  cmdSwitchWorkspace,
  cmdSwitchActiveConfig,
  cmdRevealWorkspace
} from './workspace.js';

export function registerCommands(ctx: CommandContext): vscode.Disposable[] {
  const subs: vscode.Disposable[] = [];
  const r = (id: string, handler: (...args: unknown[]) => unknown): void => {
    subs.push(vscode.commands.registerCommand(id, handler));
  };

  r('ssh-fleet.connect', arg => cmdConnect(ctx, arg));
  r('ssh-fleet.disconnect', arg => cmdDisconnect(ctx, arg));
  r('ssh-fleet.disconnectAll', () => cmdDisconnectAll(ctx));
  r('ssh-fleet.reconnectAll', () => cmdReconnectAll(ctx));
  r('ssh-fleet.connectSelected', () => cmdConnectSelected(ctx));
  r('ssh-fleet.disconnectSelected', () => cmdDisconnectSelected(ctx));
  r('ssh-fleet.updateCredential', arg => cmdUpdateCredential(ctx, arg));
  r('ssh-fleet.copyHost', arg => cmdCopyHost(ctx, arg));
  r('ssh-fleet.openTerminal', arg => cmdOpenTerminal(ctx, arg));
  r('ssh-fleet.runCommand', arg => cmdRunCommand(ctx, arg));
  r('ssh-fleet.runOnGroup', () => cmdRunOnGroup(ctx));
  r('ssh-fleet.runTask', () => cmdRunTask(ctx));
  r('ssh-fleet.runTaskByName', arg => cmdRunTaskByName(ctx, arg));
  r('ssh-fleet.runFromHistory', () => cmdRunFromHistory(ctx));
  r('ssh-fleet.insertBookmark', () => cmdInsertBookmark(ctx));
  r('ssh-fleet.openConfig', () => cmdOpenConfig(ctx));
  r('ssh-fleet.reloadConfig', () => cmdReloadConfig(ctx));
  r('ssh-fleet.refresh', () => ctx.tree.refresh());
  r('ssh-fleet.addServer', () => cmdAddServer(ctx));
  r('ssh-fleet.showConnectedQuickPick', () => cmdShowConnected(ctx));
  r('ssh-fleet.openRemoteFile', arg => cmdOpenRemoteFile(ctx, arg));
  r('ssh-fleet.mountRemoteFolder', arg => cmdMountRemoteFolder(ctx, arg));
  r('ssh-fleet.browseRemote', arg => cmdBrowseRemote(ctx, arg));
  r('ssh-fleet.downloadRemoteFile', arg => cmdDownloadRemoteFile(ctx, arg));
  r('ssh-fleet.pushToRemote', arg => cmdPushToRemote(ctx, arg));
  r('ssh-fleet.pullFromRemote', arg => cmdPullFromRemote(ctx, arg));
  r('ssh-fleet.untrackMirror', arg => cmdUntrackMirror(ctx, arg));
  r('ssh-fleet.showMirroredFiles', () => cmdShowMirroredFiles(ctx));
  r('ssh-fleet.revealMirrorFolder', () => cmdRevealMirrorFolder(ctx));
  r('ssh-fleet.uploadLocalFile', arg => cmdUploadLocalFile(ctx, arg));
  r('ssh-fleet.uploadToManyServers', arg => cmdUploadToManyServers(ctx, arg));
  r('ssh-fleet.downloadFromManyServers', () => cmdDownloadFromManyServers(ctx));
  r('ssh-fleet.manageKnownHosts', () => cmdManageKnownHosts(ctx));
  r('ssh-fleet.openTasksFolder', () => cmdOpenTasksFolder(ctx));
  r('ssh-fleet.openTaskFile', arg => cmdOpenTaskFile(ctx, arg));
  r('ssh-fleet.newTaskFile', () => cmdNewTaskFile(ctx));
  r('ssh-fleet.filterByEnv', () => cmdFilterByEnv(ctx));
  r('ssh-fleet.filterByModule', () => cmdFilterByModule(ctx));
  r('ssh-fleet.filterByText', () => cmdFilterByText(ctx));
  r('ssh-fleet.filterClear', () => cmdFilterClear(ctx));
  r('ssh-fleet.openOnSelected', () => cmdOpenOnSelected(ctx));
  r('ssh-fleet.saveAllToServers', () => cmdSaveAllToServers(ctx));
  r('ssh-fleet.diffSiblings', () => cmdDiffSiblings(ctx));
  r('ssh-fleet.copySelectedHosts', () => cmdCopySelectedHosts(ctx));
  r('ssh-fleet.saveSelectedTasksAsFile', () => cmdSaveSelectedTasksAsFile(ctx));
  r('ssh-fleet.selectAllTasks', () => cmdSelectAllTasks(ctx));
  r('ssh-fleet.deselectAllTasks', () => cmdDeselectAllTasks(ctx));
  r('ssh-fleet.taskMoveUp', arg => cmdTaskMoveUp(ctx, arg));
  r('ssh-fleet.taskMoveDown', arg => cmdTaskMoveDown(ctx, arg));
  r('ssh-fleet.enableDeselectAfterRun', () => cmdToggleDeselectAfterRun(ctx));
  r('ssh-fleet.disableDeselectAfterRun', () => cmdToggleDeselectAfterRun(ctx));
  r('ssh-fleet.selectTaskFiles', () => cmdSelectTaskFiles(ctx));
  r('ssh-fleet.setupWorkspace', () => cmdSetupWorkspace(ctx));
  r('ssh-fleet.switchWorkspace', () => cmdSwitchWorkspace(ctx));
  r('ssh-fleet.switchActiveConfig', arg => cmdSwitchActiveConfig(ctx, arg));
  r('ssh-fleet.revealWorkspace', () => cmdRevealWorkspace(ctx));

  return subs;
}
