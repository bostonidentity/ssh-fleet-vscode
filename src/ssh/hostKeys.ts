import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { log } from '../util/logger.js';
import { fingerprintSha256 } from './fingerprint.js';
import type { Workspace } from '../workspace.js';

export { fingerprintSha256 };

interface KnownEntry {
  /** ssh2 key type identifier, e.g. 'ssh-ed25519', 'ssh-rsa'. */
  algorithm: string;
  /** Base64-encoded SHA-256 of the key bytes. Matches `ssh-keygen -lf` output. */
  sha256: string;
  acceptedAt: number;
}

type KnownStore = Record<string, KnownEntry>;

function key(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/**
 * Persistent host-key trust store. Lives at `<globalStorage>/known_hosts.json`
 * — separate from `~/.ssh/known_hosts` so we don't have to deal with
 * OpenSSH's hashed-hostname parsing.
 */
export class HostKeyStore {
  private cache: KnownStore | undefined;
  /** Paths we've already warned about for corruption — don't re-warn every
   *  read. Cleared when the workspace switches. */
  private warnedCorrupt = new Set<string>();

  constructor(
    private readonly extCtx: vscode.ExtensionContext,
    private readonly workspace: Workspace
  ) {
    this.workspace.onDidChange(() => {
      // Workspace switched → drop cached known-hosts so we re-load from the new path.
      this.cache = undefined;
      this.warnedCorrupt.clear();
    });
  }

  /** Active known_hosts file path — under the workspace if set, else extension globalStorage. */
  private get path(): string {
    const ws = this.workspace.knownHostsPath();
    return ws ?? path.join(this.extCtx.globalStorageUri.fsPath, 'known_hosts.json');
  }

  private async load(): Promise<KnownStore> {
    if (this.cache) {
      return this.cache;
    }
    const filePath = this.path;
    try {
      const text = await fs.readFile(filePath, 'utf-8');
      this.cache = JSON.parse(text) as KnownStore;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = {};
      } else {
        // Corrupt known_hosts silently demotes every previously-trusted host
        // back to TOFU. Surface this once (per session per file path) so the
        // operator knows their trust store needs attention.
        log.warn(`known_hosts read failed: ${(err as Error).message}`);
        this.cache = {};
        if (!this.warnedCorrupt.has(filePath)) {
          this.warnedCorrupt.add(filePath);
          void vscode.window.showWarningMessage(
            `SSH Fleet: known_hosts file is unreadable — every server will prompt for trust again until this is fixed.`,
            { detail: `${filePath}\n\n${(err as Error).message}` } as vscode.MessageOptions,
            'Show File'
          ).then(action => {
            if (action === 'Show File') {
              void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
            }
          });
        }
      }
    }
    return this.cache;
  }

  private async save(): Promise<void> {
    if (!this.cache) {
      return;
    }
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, JSON.stringify(this.cache, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  async list(): Promise<{ entry: KnownEntry; host: string }[]> {
    const store = await this.load();
    return Object.entries(store).map(([host, entry]) => ({ host, entry }));
  }

  async lookup(host: string, port: number): Promise<KnownEntry | undefined> {
    const store = await this.load();
    return store[key(host, port)];
  }

  async accept(host: string, port: number, algorithm: string, sha256: string): Promise<void> {
    const store = await this.load();
    store[key(host, port)] = { algorithm, sha256, acceptedAt: Date.now() };
    await this.save();
  }

  async forget(host: string, port: number): Promise<void> {
    const store = await this.load();
    delete store[key(host, port)];
    await this.save();
  }
}

/**
 * Decision returned by the verifier: trust this connection (resolve true),
 * reject (resolve false), and side-effects on the trust store happen inline.
 */
export async function verifyHostKey(
  store: HostKeyStore,
  host: string,
  port: number,
  algorithm: string,
  keyBuf: Buffer
): Promise<boolean> {
  const sha256 = fingerprintSha256(keyBuf);
  const known = await store.lookup(host, port);

  if (known && known.sha256 === sha256 && known.algorithm === algorithm) {
    return true;
  }

  if (known) {
    // Mismatch — possible MITM. Hard refuse with a prominent warning.
    const action = await vscode.window.showErrorMessage(
      `⚠️ Host key for ${host}:${port} has CHANGED.`,
      {
        modal: true,
        detail:
          `Previously trusted: ${known.algorithm} SHA256:${known.sha256}\n` +
          `Now offering:        ${algorithm} SHA256:${sha256}\n\n` +
          `This could be a man-in-the-middle attack. Refusing the connection.`
      },
      'Forget previous and accept new key'
    );
    if (action === 'Forget previous and accept new key') {
      await store.accept(host, port, algorithm, sha256);
      return true;
    }
    return false;
  }

  // First time — trust on first use prompt.
  const accept = await vscode.window.showWarningMessage(
    `Connecting to ${host}:${port} for the first time.`,
    {
      modal: true,
      detail:
        `Algorithm: ${algorithm}\n` +
        `Fingerprint: SHA256:${sha256}\n\n` +
        `Verify this matches the server's expected fingerprint before continuing.`
    },
    'Trust and Continue'
  );
  if (accept === 'Trust and Continue') {
    await store.accept(host, port, algorithm, sha256);
    return true;
  }
  return false;
}
