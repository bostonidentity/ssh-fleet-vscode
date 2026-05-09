import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as YAML from 'yaml';
import type { CommandContext } from './context.js';

export async function cmdAddServer(ctx: CommandContext): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: 'Server name (used in TreeView)',
    placeHolder: 'web-01',
    ignoreFocusOut: true
  });
  if (!name) {
    return;
  }

  const hostInput = await vscode.window.showInputBox({
    prompt: 'Host (or user@host or user@host:port)',
    placeHolder: 'deploy@10.1.2.3',
    ignoreFocusOut: true
  });
  if (!hostInput) {
    return;
  }
  const { user: parsedUser, host, port } = parseHostShorthand(hostInput);

  const user = parsedUser ?? await vscode.window.showInputBox({
    prompt: 'Username',
    placeHolder: 'deploy',
    ignoreFocusOut: true
  });
  if (!user) {
    return;
  }

  const authType = await vscode.window.showQuickPick(['key', 'password', 'agent'], {
    title: 'Authentication type'
  });
  if (!authType) {
    return;
  }

  const groupsRaw = await vscode.window.showInputBox({
    prompt: 'Groups (comma-separated, optional)',
    placeHolder: 'prod, web'
  });
  const groups = groupsRaw ? groupsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

  const newEntry: Record<string, unknown> = { name, host, port, user, groups };

  if (authType === 'key') {
    const keyPath = await vscode.window.showInputBox({
      prompt: 'Path to private key',
      placeHolder: '~/.ssh/id_ed25519',
      ignoreFocusOut: true
    });
    if (!keyPath) {
      return;
    }
    newEntry.auth = { type: 'key', keyPath };
  } else if (authType === 'password') {
    const ref = `${name}-password`;
    const password = await vscode.window.showInputBox({
      prompt: `Password (will be stored in keychain as '${ref}')`,
      password: true,
      ignoreFocusOut: true
    });
    if (password === undefined) {
      return;
    }
    if (password) {
      await ctx.secrets.set(ref, password);
    }
    newEntry.auth = { type: 'password', passwordRef: ref };
  } else {
    newEntry.auth = { type: 'agent' };
  }

  await appendToConfig(newEntry);
  await ctx.config.reload();
  void vscode.window.showInformationMessage(`SSH Fleet: added '${name}'.`);
}

function parseHostShorthand(input: string): { user?: string; host: string; port: number } {
  let port = 22;
  let user: string | undefined;
  let rest = input.trim();
  const at = rest.indexOf('@');
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  const colon = rest.lastIndexOf(':');
  if (colon >= 0) {
    const portStr = rest.slice(colon + 1);
    const parsed = Number(portStr);
    if (Number.isFinite(parsed) && parsed > 0) {
      port = parsed;
      rest = rest.slice(0, colon);
    }
  }
  return { user, host: rest, port };
}

async function appendToConfig(entry: Record<string, unknown>): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) {
    throw new Error('Open a workspace folder first to add servers.');
  }
  const target = path.join(folder, '.vscode', 'ssh-fleet.yml');
  let text = '';
  try {
    text = await fs.readFile(target, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
  }
  const doc = text
    ? YAML.parseDocument(text)
    : new YAML.Document({ servers: [] });
  if (!doc.has('servers')) {
    doc.set('servers', new YAML.YAMLSeq());
  }
  const seq = doc.get('servers') as YAML.YAMLSeq;
  seq.add(entry);
  await fs.writeFile(target, doc.toString({ lineWidth: 0 }), 'utf-8');
}
