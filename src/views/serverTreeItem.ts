import * as vscode from 'vscode';
import type { ServerConfig, ConnectionState } from '../config/types.js';

export type TreeNode = GroupNode | ServerNode | FilterRootNode | FilterValueNode;

/**
 * Synthetic top-level filter row in the Servers TreeView. Env / Module rows
 * are expandable: each child is a checkbox row for one possible value, so
 * multi-select happens *inline* in the sidebar instead of a popup picker.
 * Text and Clear stay as leaf rows that trigger commands when clicked.
 */
export class FilterRootNode extends vscode.TreeItem {
  readonly kind = 'filter-root' as const;
  constructor(
    readonly axis: 'env' | 'module' | 'text' | 'clear',
    label: string,
    description: string,
    iconId: string,
    options: { expandable: boolean; commandId?: string }
  ) {
    super(
      label,
      options.expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = `filter-${axis}`;
    if (options.commandId) {
      this.command = { command: options.commandId, title: label };
    }
    this.tooltip = description ? `${label}: ${description}` : label;
  }
}

/**
 * One selectable value under a Filter Env / Module root. Renders with a
 * native TreeView checkbox so toggling fires `onDidChangeCheckboxState`,
 * which the provider translates into a `serverFilter.toggleEnv/Module` call.
 */
export class FilterValueNode extends vscode.TreeItem {
  readonly kind = 'filter-value' as const;
  constructor(
    readonly axis: 'env' | 'module',
    readonly value: string,
    selected: boolean
  ) {
    super(value, vscode.TreeItemCollapsibleState.None);
    this.contextValue = `filter-value-${axis}`;
    this.checkboxState = selected
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
  }
}

/** Sentinel group name for the synthetic "All servers" wrapper that
 *  appears when no server has any explicit `groups:` field. Picked to
 *  not collide with any plausible user-defined group name. */
export const ALL_SERVERS_GROUP = '__all__';

export class GroupNode extends vscode.TreeItem {
  readonly kind = 'group' as const;
  constructor(readonly group: string, readonly count: number) {
    const displayName = group === ALL_SERVERS_GROUP ? 'All servers' : group;
    super(`${displayName} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = group === ALL_SERVERS_GROUP ? 'group-all' : 'group';
    this.iconPath = new vscode.ThemeIcon(group === ALL_SERVERS_GROUP ? 'server' : 'folder');
  }
}

export class ServerNode extends vscode.TreeItem {
  readonly kind = 'server' as const;
  constructor(
    readonly server: ServerConfig,
    readonly state: ConnectionState,
    readonly errorMessage: string | undefined,
    readonly warnLabel: { label: string; color: string } | undefined,
    selected: boolean,
    extensionUri: vscode.Uri
  ) {
    super(server.name, vscode.TreeItemCollapsibleState.None);

    const stateText = state === 'connected'
      ? 'connected'
      : state === 'connecting'
        ? 'connecting…'
        : state === 'error'
          ? `error: ${errorMessage ?? 'unknown'}`
          : 'idle';

    // Mark password servers that opted out of caching — typically OTP /
    // dynamic-password setups where every connect prompts fresh. The badge
    // tells operators "this one will ask you every time, that's by design,
    // not a bug" — without it the per-connect prompt looks broken.
    const isOtp =
      server.auth.type === 'password' && server.auth.cachePassword === false;

    // Description carries the warn badge (when present) and an OTP marker.
    // `user@host` lives in the tooltip, so the row stays compact while still
    // showing critical "this is PROD" / "this needs OTP" cues at a glance.
    const badges: string[] = [];
    if (warnLabel) badges.push(`${colorEmoji(warnLabel.color)} ${warnLabel.label}`);
    if (isOtp) badges.push('🔐 OTP');
    this.description = badges.join('  ');
    this.tooltip = new vscode.MarkdownString(
      `**${server.name}**\n\n` +
      `\`${server.user}@${server.host}:${server.port}\`\n\n` +
      `state: ${stateText}\n\n` +
      (server.groups.length > 0 ? `groups: ${server.groups.join(', ')}\n\n` : '') +
      (warnLabel ? `⚠️ tagged: \`${warnLabel.label}\`\n\n` : '') +
      (isOtp ? '🔐 prompts every connect (`cachePassword: false`)' : '')
    );
    // SVG icons with hard-coded fill colours so VSCode doesn't recolour them
    // when the row is focused/selected (ThemeIcon + ThemeColor gets overridden
    // by list.activeSelectionForeground — fine for built-in icons, wrong here
    // because state colour carries semantics).
    const iconUri = vscode.Uri.joinPath(extensionUri, 'resources', 'icons', `state-${state}.svg`);
    this.iconPath = { light: iconUri, dark: iconUri };
    this.contextValue = state === 'connected' ? 'server-connected' : 'server';
    this.checkboxState = selected
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    // No default click command — toggling selection (checkbox) is the primary action.
  }
}

/** Map a hex colour from config to the closest emoji dot for visual TreeView badges. */
function colorEmoji(hex: string): string {
  const m = hex.match(/^#([0-9a-fA-F]{3,8})$/);
  if (!m) {
    return '🏷️';
  }
  let h = m[1];
  if (h.length === 3) {
    h = h.split('').map(c => c + c).join('');
  } else if (h.length === 8) {
    h = h.slice(0, 6);
  } else if (h.length !== 6) {
    return '🏷️';
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 32) {
    return max < 64 ? '⚫' : max > 192 ? '⚪' : '🟤';
  }
  if (r >= g && r >= b) {
    return g > 160 ? '🟡' : '🔴';
  }
  if (g >= r && g >= b) {
    return b > 160 ? '🔵' : '🟢';
  }
  return r > 160 ? '🟣' : '🔵';
}

