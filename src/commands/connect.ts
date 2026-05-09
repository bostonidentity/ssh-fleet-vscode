import * as vscode from 'vscode';
import type { CommandContext } from './context.js';
import type { ServerConfig } from '../config/types.js';
import { extractServerName, pickServer } from './serverPicker.js';
import { enforceServerCap } from './helpers.js';

const AUTH_FAIL_RE = /authentication methods failed|auth\s+(failed|rejected|denied)|password\s+rejected|access denied/i;
const PASSPHRASE_FAIL_RE = /passphrase|encrypted\s+OpenSSH\s+private\s+key/i;

/**
 * Wrap a connect-and-recover-from-bad-secret attempt.
 *
 * If ssh2 rejects auth, the most likely cause is a stale password / passphrase
 * in SecretStorage (user typed it wrong on first prompt and getOrPrompt
 * faithfully re-uses it forever). We surface that as an actionable error:
 * one click forgets the bad secret and re-prompts.
 */
export async function connectWithRetry(
  ctx: CommandContext,
  server: ServerConfig,
  attempt: number = 0
): Promise<boolean> {
  try {
    await ctx.registry.ensure(server);
    return true;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const ref = badSecretRef(server, msg);
    if (ref && attempt === 0) {
      const choice = await vscode.window.showErrorMessage(
        `SSH Fleet: ${server.name} rejected the credential.\n\n${msg}`,
        'Re-enter & retry',
        'Cancel'
      );
      if (choice === 'Re-enter & retry') {
        await ctx.secrets.delete(ref);
        // The connection object may be in 'error' state — drop it so a fresh
        // Client gets created with the new credential.
        ctx.registry.disconnect(server.name);
        return connectWithRetry(ctx, server, attempt + 1);
      }
      return false;
    }
    // Map well-known transport / auth failures to actionable buttons so
    // the operator's next click is one step toward fixing the cause
    // rather than a context-less "connect failed" toast.
    const action = await pickConnectErrorAction(msg);
    if (action) {
      const choice = await vscode.window.showErrorMessage(
        `SSH Fleet: ${server.name} — ${msg}`, action.label
      );
      if (choice === action.label) await action.run(ctx, server);
      return false;
    }
    void vscode.window.showErrorMessage(`SSH Fleet: connect failed — ${msg}`);
    return false;
  }
}

interface ConnectErrorAction {
  label: string;
  run: (ctx: CommandContext, server: ServerConfig) => Promise<void>;
}

function pickConnectErrorAction(msg: string): Promise<ConnectErrorAction | undefined> {
  // Permission denied (auth methods exhausted but not a stored-secret bug —
  // the credential rotation case is already handled above via badSecretRef)
  if (/permission denied|auth.*(failed|rejected)/i.test(msg)) {
    return Promise.resolve({
      label: 'Update Credential',
      run: async (_ctx, server) =>
        vscode.commands.executeCommand('ssh-fleet.updateCredential', { server: server.name }),
    });
  }
  // Host key changed / mismatched — operator may have rebuilt the box and
  // expects a new fingerprint; needs to delete the stored entry first.
  if (/host key.*(changed|mismatch|verification failed)/i.test(msg)) {
    return Promise.resolve({
      label: 'Manage Known Hosts',
      run: async () =>
        vscode.commands.executeCommand('ssh-fleet.manageKnownHosts'),
    });
  }
  // Network-layer issues — operator most likely needs to fix the host /
  // port in their config (typo, wrong env, VPN down, etc.).
  if (/connection refused|timed out|getaddrinfo|ENOTFOUND|EHOSTUNREACH|ECONNREFUSED/i.test(msg)) {
    return Promise.resolve({
      label: 'Open Config',
      run: async () =>
        vscode.commands.executeCommand('ssh-fleet.openConfig'),
    });
  }
  return Promise.resolve(undefined);
}

function badSecretRef(server: ServerConfig, errorMessage: string): string | undefined {
  if (server.auth.type === 'password' && AUTH_FAIL_RE.test(errorMessage)) {
    return server.auth.passwordRef;
  }
  if (server.auth.type === 'key' && PASSPHRASE_FAIL_RE.test(errorMessage)) {
    return server.auth.passphraseRef;
  }
  return undefined;
}

export async function cmdConnect(ctx: CommandContext, arg: unknown): Promise<void> {
  const server = await pickServer(ctx.config.config, arg, 'Connect to server');
  if (!server) {
    return;
  }
  // Success is visible via TreeView state-icon + status bar; failure path
  // surfaces its own warning/Re-enter-and-retry flow inside connectWithRetry.
  await connectWithRetry(ctx, server);
}

/** Copy the server's hostname to the clipboard. The TreeView right-click
 *  passes the server's TreeItem; we extract the name and look up the
 *  current host in the config (in case the operator changed `host:` after
 *  the tree was built). Uses a brief toast as feedback so the operator
 *  knows the copy landed. */
export async function cmdCopyHost(ctx: CommandContext, arg: unknown): Promise<void> {
  const server = await pickServer(ctx.config.config, arg, 'Copy host of which server?');
  if (!server) return;
  await vscode.env.clipboard.writeText(server.host);
  void vscode.window.setStatusBarMessage(`SSH Fleet: copied ${server.host}`, 2000);
}

/** Connect every server currently ticked in the TreeView, in parallel. */
export async function cmdConnectSelected(ctx: CommandContext): Promise<void> {
  const names = ctx.selection.servers;
  if (names.length === 0) {
    void vscode.window.showInformationMessage(
      'SSH Fleet: tick at least one server in the sidebar first.'
    );
    return;
  }
  if (!enforceServerCap(ctx, names.length, 'Connect Selected')) return;
  const targets = names
    .map(n => ctx.config.config.servers.find(s => s.name === n))
    .filter((s): s is ServerConfig => !!s);
  const results = await Promise.all(targets.map(s => connectWithRetry(ctx, s)));
  const failed = results.filter(r => !r).length;
  if (failed > 0) {
    void vscode.window.showWarningMessage(
      `SSH Fleet: ${results.length - failed}/${results.length} connected; ${failed} failed (see output).`
    );
  }
  // Success path: silent — TreeView dots turn green, status bar updates.
}

/** Disconnect every server currently ticked. */
export function cmdDisconnectSelected(ctx: CommandContext): void {
  const names = ctx.selection.servers;
  if (names.length === 0) {
    void vscode.window.showInformationMessage(
      'SSH Fleet: tick at least one server in the sidebar first.'
    );
    return;
  }
  for (const name of names) {
    closeForServer(ctx, name);
  }
}

export function cmdDisconnect(ctx: CommandContext, arg: unknown): void {
  const fromArg = extractServerName(arg);
  if (fromArg) {
    closeForServer(ctx, fromArg);
    return;
  }
  const list = ctx.registry.list().map(c => c.server.name);
  if (list.length === 0) {
    void vscode.window.showInformationMessage('SSH Fleet: nothing connected.');
    return;
  }
  void vscode.window.showQuickPick(list, { title: 'Disconnect which server?' }).then(name => {
    if (name) {
      closeForServer(ctx, name);
    }
  });
}

export function cmdDisconnectAll(ctx: CommandContext): void {
  for (const conn of ctx.registry.list()) {
    closeForServer(ctx, conn.server.name);
  }
}

/**
 * Connect every configured server that's currently idle/error. Useful after
 * sleep-wake (where TCP keepalive killed all connections at once) or when
 * starting a session and you want everything online without per-server
 * clicks. Already-connected servers are left alone.
 */
export async function cmdReconnectAll(ctx: CommandContext): Promise<void> {
  const all = ctx.config.config.servers;
  const targets = all.filter(s => {
    const live = ctx.registry.get(s.name);
    return !live || live.state === 'idle' || live.state === 'error';
  });
  if (targets.length === 0) {
    void vscode.window.showInformationMessage(
      `SSH Fleet: all ${all.length} server(s) already connected.`
    );
    return;
  }
  if (!enforceServerCap(ctx, targets.length, 'Reconnect All')) return;
  const results = await Promise.all(targets.map(s => connectWithRetry(ctx, s)));
  const ok = results.filter(r => r).length;
  const failed = results.length - ok;
  if (failed === 0) {
    void vscode.window.showInformationMessage(
      `SSH Fleet: reconnected ${ok}/${targets.length} server(s).`
    );
  } else {
    void vscode.window.showWarningMessage(
      `SSH Fleet: reconnected ${ok}/${targets.length}; ${failed} still failing.`
    );
  }
}

/**
 * Manual "the password rotated, here's the new one" entry point. Purges
 * the cached SecretStorage entry for the server's auth ref and prompts
 * for a new value, storing it back. Disconnects the server first so the
 * next connect picks up the new credential.
 */
export async function cmdUpdateCredential(ctx: CommandContext, arg: unknown): Promise<void> {
  const server = await pickServer(ctx.config.config, arg, 'Update credential for…');
  if (!server) return;

  let ref: string | undefined;
  let label: string;
  if (server.auth.type === 'password') {
    ref = server.auth.passwordRef;
    label = `Password for ${server.user}@${server.host}`;
  } else if (server.auth.type === 'key') {
    ref = server.auth.passphraseRef;
    if (!ref) {
      void vscode.window.showInformationMessage(
        `SSH Fleet: ${server.name} uses key auth without a stored passphrase — nothing to update here.`
      );
      return;
    }
    label = `Passphrase for ${server.auth.keyPath ?? '(default key)'}`;
  } else {
    void vscode.window.showInformationMessage(
      `SSH Fleet: ${server.name} uses agent auth — credentials live in your local ssh-agent, not in ssh-fleet.`
    );
    return;
  }
  if (!ref) {
    void vscode.window.showWarningMessage(
      `SSH Fleet: ${server.name}'s auth has no \`passwordRef\` / \`passphraseRef\` set — add one to the YAML so the credential can be cached.`
    );
    return;
  }

  // Disconnect first so the next operation re-auths against the new value.
  closeForServer(ctx, server.name);
  // Purge the old, then prompt → store via getOrPrompt's existing flow.
  await ctx.secrets.delete(ref);
  const fresh = await ctx.secrets.getOrPrompt(ref, label);
  if (fresh) {
    void vscode.window.showInformationMessage(
      `SSH Fleet: credential updated for ${server.name}. Next connect will use the new value.`
    );
  } else {
    void vscode.window.showInformationMessage(
      `SSH Fleet: credential for ${server.name} cleared (cancelled).`
    );
  }
}

function closeForServer(ctx: CommandContext, name: string): void {
  const term = ctx.terminals.get(name);
  if (term) {
    term.dispose();
    ctx.terminals.delete(name);
  }
  ctx.registry.disconnect(name);
}
