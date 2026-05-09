import * as vscode from 'vscode';
import type { ServerConfig, AppConfig } from '../config/types.js';

export interface PickArg {
  serverName?: string;
}

/**
 * Pull a server name out of whatever VSCode handed us. Three shapes:
 *  - `{ serverName: string }`        — what we set on TreeItem.command.arguments
 *  - `{ server: ServerConfig }`      — the TreeItem itself (context-menu / inline icon)
 *  - `string`                         — name passed positionally
 */
export function extractServerName(arg: unknown): string | undefined {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg && typeof arg === 'object') {
    const a = arg as { serverName?: string; server?: { name?: string } };
    if (typeof a.serverName === 'string') {
      return a.serverName;
    }
    if (a.server && typeof a.server.name === 'string') {
      return a.server.name;
    }
  }
  return undefined;
}

/**
 * Resolve a server from a passed-in arg (TreeView right-click, inline icon,
 * status-bar picker, etc.) — falling back to a QuickPick if nothing was passed
 * or the arg didn't identify any known server.
 */
export async function pickServer(
  config: AppConfig,
  arg: unknown,
  promptTitle = 'Select a server'
): Promise<ServerConfig | undefined> {
  const fromArg = extractServerName(arg);
  if (fromArg) {
    const found = config.servers.find(s => s.name === fromArg);
    if (found) {
      return found;
    }
  }
  if (config.servers.length === 0) {
    void vscode.window.showWarningMessage('SSH Fleet: no servers configured. Open the config file to add some.');
    return undefined;
  }

  const items = config.servers.map(s => ({
    label: s.name,
    description: `${s.user}@${s.host}:${s.port}`,
    detail: s.groups.length > 0 ? s.groups.map(g => `@${g}`).join(' ') : undefined,
    server: s
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: promptTitle,
    matchOnDescription: true,
    matchOnDetail: true,
    placeHolder: 'type to filter — try @group:prod or hostname'
  });
  return picked?.server;
}

export async function pickServers(
  config: AppConfig,
  promptTitle = 'Select servers (multi-select)'
): Promise<ServerConfig[]> {
  if (config.servers.length === 0) {
    void vscode.window.showWarningMessage('SSH Fleet: no servers configured.');
    return [];
  }
  const items = config.servers.map(s => ({
    label: s.name,
    description: `${s.user}@${s.host}:${s.port}`,
    detail: s.groups.length > 0 ? s.groups.map(g => `@${g}`).join(' ') : undefined,
    server: s,
    picked: false
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: promptTitle,
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true
  });
  return picked?.map(p => p.server) ?? [];
}
