import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ConnectionRegistry } from '../ssh/connection.js';
import type { ConfigStore } from '../config/loader.js';
import type { Workspace } from '../workspace.js';
import { log } from '../util/logger.js';
import { runRemoteCommand } from '../ssh/runner.js';
import { buildSftpBackupCommand } from './backup.js';

const MANIFEST_KEY = 'ssh-fleet.mirror.v1';

/** Folders that might appear under the mirror root for reasons unrelated
 *  to mirroring — VCS metadata, dependency caches, OS junk. We don't
 *  want `tryAutoTrack` to synthesize entries for files inside these. */
const TRACK_DENYLIST = new Set([
  '.git', '.hg', '.svn', '.DS_Store',
  'node_modules', '.cache', '.tmp'
]);

export interface MirrorEntry {
  localPath: string;
  serverName: string;
  remotePath: string;
  downloadedAt: number;
  remoteMtimeAtDownload: number;
  remoteSizeAtDownload: number;
  contentHashAtDownload: string;
}

type Manifest = Record<string, MirrorEntry>;

export type MirrorState =
  | { status: 'clean' }
  | { status: 'modified'; localHash: string }
  | { status: 'untracked' };

function sha256(buf: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function safeRemotePath(remotePath: string): string {
  // Strip leading slash so paths nest under <mirror>/<server>/<rest>.
  // Replace null bytes / NUL — everything else is fine on posix and on
  // macOS APFS (Windows users will pay for ":" eventually but that's a
  // VSIX-publishing-day problem).
  return remotePath.replace(/^\/+/, '').replace(/\0/g, '_');
}

export class MirrorStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<MirrorEntry | undefined>();
  /** Fires with the affected entry, or undefined for a multi-entry change. */
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly extCtx: vscode.ExtensionContext,
    private readonly registry: ConnectionRegistry,
    private readonly config: ConfigStore,
    private readonly workspace: Workspace
  ) {}

  /**
   * Absolute filesystem path of the mirror root.
   * Lives under the user-chosen workspace at <workdir>/mirror — Finder/Explorer
   * can browse it directly; deleting the workspace cleans everything up.
   * Falls back to the extension's globalStorage if no workspace is set yet.
   */
  get rootPath(): string {
    const wsMirror = this.workspace.mirrorDir();
    return wsMirror ?? path.join(this.extCtx.globalStorageUri.fsPath, 'mirror');
  }

  private read(): Manifest {
    return this.extCtx.globalState.get<Manifest>(MANIFEST_KEY) ?? {};
  }

  private async write(m: Manifest): Promise<void> {
    await this.extCtx.globalState.update(MANIFEST_KEY, m);
  }

  list(): MirrorEntry[] {
    return Object.values(this.read());
  }

  get(localPath: string): MirrorEntry | undefined {
    const m = this.read();
    const direct = m[localPath];
    if (direct) return direct;
    // Windows: drive-letter casing differs between code paths. The
    // manifest is keyed off whatever `path.join` produced at download
    // time (typically capital `C:\...`), but VS Code's
    // `Uri.file(p).fsPath` returns lowercase `c:\...`. Fall back to a
    // linear case-insensitive lookup so the editor URI's path still
    // resolves to its manifest entry. POSIX paths stay strict because
    // case is genuinely meaningful there.
    if (process.platform === 'win32') {
      const lower = localPath.toLowerCase();
      for (const k in m) {
        if (k.toLowerCase() === lower) return m[k];
      }
    }
    return undefined;
  }

  /** Map an active editor URI to its mirror entry, or undefined. */
  forUri(uri: vscode.Uri): MirrorEntry | undefined {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const exact = this.get(uri.fsPath);
    if (exact) {
      log.info(`Mirror: forUri exact-hit for ${uri.fsPath} → ${exact.serverName}:${exact.remotePath}`);
      return exact;
    }
    log.info(`Mirror: forUri exact-miss for ${uri.fsPath}; rootPath=${this.rootPath}`);
    // Path-convention fallback: a file living under
    // `<rootPath>/<knownServer>/<remote-path>` is conventionally a
    // mirror file even if THIS machine's manifest doesn't know about
    // it (manifest is stored in globalState — per-machine — so a
    // fresh marketplace install on a second workstation has empty
    // manifest even when the file synced over via git/Dropbox/rsync
    // from another machine where it was downloaded).
    //
    // We only auto-track when the leading segment matches a CURRENTLY-
    // CONFIGURED server, so unrelated files happening to live under
    // `<rootPath>/some-folder/...` aren't misclassified.
    return this.tryAutoTrack(uri.fsPath);
  }

  /**
   * Synthesize and persist a manifest entry for a file that lives under
   * the conventional mirror layout. Returns the new entry, or undefined
   * if the path doesn't match the convention or the implied server name
   * isn't in the active config.
   *
   * Synthetic fields (`remoteMtimeAtDownload`, `contentHashAtDownload`,
   * `remoteSizeAtDownload`, `downloadedAt`) are zero/empty — we don't
   * know what the file looked like at "download time" because we
   * weren't there. Push works regardless (only needs server +
   * remotePath); Pull will see mismatched mtime and may show its
   * external-modification warning until a real push or pull settles
   * the metadata.
   */
  private tryAutoTrack(localPath: string): MirrorEntry | undefined {
    const root = this.rootPath;
    const sep = path.sep;
    // Case-insensitive prefix check on Windows (drive letters and even
    // some folders can vary in case between `path.join` output and
    // VS Code's `Uri.file().fsPath`). POSIX stays strict — `/Foo` and
    // `/foo` are different paths there.
    const rootWithSep = root + sep;
    const matches = process.platform === 'win32'
      ? localPath.toLowerCase().startsWith(rootWithSep.toLowerCase())
      : localPath.startsWith(rootWithSep);
    if (!matches) {
      log.info(`Mirror: auto-track skipped (path outside rootPath ${root}): ${localPath}`);
      return undefined;
    }
    const rel = localPath.slice(root.length + 1);
    const firstSep = rel.indexOf(sep);
    if (firstSep <= 0) {
      log.info(`Mirror: auto-track skipped (no <server>/ segment): ${localPath}`);
      return undefined;
    }
    const serverName = rel.slice(0, firstSep);
    // Denylist for non-mirror folders that might happen to live under
    // `<root>/`. We deliberately do NOT require `serverName` to be in the
    // active config — a fresh workstation opening a synced workspace
    // often has the files but not (yet) the matching server entries.
    // The path convention is strong enough on its own; push/pull will
    // surface a clear "no such server" error later if the synthesized
    // serverName is genuinely invalid.
    if (TRACK_DENYLIST.has(serverName) || serverName.startsWith('.')) {
      log.info(`Mirror: auto-track skipped (segment '${serverName}' on denylist): ${localPath}`);
      return undefined;
    }
    // Reverse safeRemotePath: prepend `/` and POSIX-normalize separators
    // so Windows paths come back to canonical remote form.
    const remoteRel = rel.slice(firstSep + 1).split(sep).join('/');
    const remotePath = '/' + remoteRel;
    const entry: MirrorEntry = {
      localPath,
      serverName,
      remotePath,
      downloadedAt: 0,
      remoteMtimeAtDownload: 0,
      remoteSizeAtDownload: 0,
      contentHashAtDownload: ''
    };
    // Fire-and-forget persistence — the in-memory return is what the
    // current call needs; subsequent lookups read from the persisted
    // manifest.
    void this.write({ ...this.read(), [localPath]: entry });
    log.info(`Mirror: auto-tracked ${serverName}:${remotePath} from existing local file ${localPath}`);
    this.emitter.fire(entry);
    return entry;
  }

  localPathFor(serverName: string, remotePath: string): string {
    return path.join(this.rootPath, serverName, safeRemotePath(remotePath));
  }

  /**
   * Fetch a remote file into the local mirror dir, overwriting whatever was
   * there before. Returns the new mirror entry.
   */
  async download(serverName: string, remotePath: string): Promise<MirrorEntry> {
    const server = this.config.config.servers.find(s => s.name === serverName);
    if (!server) {
      throw new Error(`Unknown server '${serverName}'`);
    }
    const conn = await this.registry.ensure(server);
    const sftp = conn.sftp;

    const stat = await sftp.stat(remotePath);
    if (stat.isDirectory) {
      throw new Error(`${remotePath} is a directory; download only supports files`);
    }
    const data = await sftp.readFile(remotePath);

    const localPath = this.localPathFor(serverName, remotePath);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, data);

    const entry: MirrorEntry = {
      localPath,
      serverName,
      remotePath,
      downloadedAt: Date.now(),
      remoteMtimeAtDownload: stat.mtime,
      remoteSizeAtDownload: stat.size,
      contentHashAtDownload: sha256(data)
    };
    const m = this.read();
    m[localPath] = entry;
    await this.write(m);
    log.info(`Mirror: downloaded ${serverName}:${remotePath} -> ${localPath}`);
    this.emitter.fire(entry);
    return entry;
  }

  /**
   * Upload an existing local file to a remote path and track it in the manifest
   * — without copying the file into the mirror dir. The local file stays where
   * the user put it; subsequent push/pull use its original location.
   */
  async upload(localPath: string, serverName: string, remotePath: string): Promise<MirrorEntry> {
    const server = this.config.config.servers.find(s => s.name === serverName);
    if (!server) {
      throw new Error(`Unknown server '${serverName}'`);
    }
    const conn = await this.registry.ensure(server);
    const data = await fs.readFile(localPath);
    // Auto-backup the existing remote file (if any) before clobbering.
    // SFTP writeFile bypasses the shell, so wrapBackup doesn't fire on
    // its own — the helper emits a server-side `cp -a` we run via runRemoteCommand.
    const backupCmd = buildSftpBackupCommand(remotePath, this.config.config.safety.autoBackup);
    if (backupCmd) {
      const r = await runRemoteCommand(conn, backupCmd, { timeoutMs: 30_000 });
      if (r.exitCode !== 0) {
        throw new Error(`auto-backup failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`}`);
      }
    }
    await conn.sftp.writeFile(remotePath, data);
    const stat = await conn.sftp.stat(remotePath);

    const entry: MirrorEntry = {
      localPath,
      serverName,
      remotePath,
      downloadedAt: Date.now(),
      remoteMtimeAtDownload: stat.mtime,
      remoteSizeAtDownload: stat.size,
      contentHashAtDownload: sha256(data)
    };
    const m = this.read();
    m[localPath] = entry;
    await this.write(m);
    log.info(`Mirror: uploaded ${localPath} -> ${serverName}:${remotePath}`);
    this.emitter.fire(entry);
    return entry;
  }

  async untrack(localPath: string): Promise<void> {
    const m = this.read();
    if (!(localPath in m)) {
      return;
    }
    delete m[localPath];
    await this.write(m);
    this.emitter.fire(undefined);
  }

  /**
   * Compare current local content with the snapshot recorded at last
   * download/push. Returns 'clean' if unchanged or 'modified' with the new hash.
   */
  async stateFor(entry: MirrorEntry): Promise<MirrorState> {
    try {
      const data = await fs.readFile(entry.localPath);
      const hash = sha256(data);
      if (hash === entry.contentHashAtDownload) {
        return { status: 'clean' };
      }
      return { status: 'modified', localHash: hash };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { status: 'untracked' };
      }
      throw err;
    }
  }

  /** Read remote file's current mtime/size — for conflict detection before push. */
  async statRemote(entry: MirrorEntry): Promise<{ mtime: number; size: number }> {
    const server = this.config.config.servers.find(s => s.name === entry.serverName);
    if (!server) {
      throw new Error(`Unknown server '${entry.serverName}'`);
    }
    const conn = await this.registry.ensure(server);
    const stat = await conn.sftp.stat(entry.remotePath);
    return { mtime: stat.mtime, size: stat.size };
  }

  /**
   * Upload local content to remote and update the manifest's "last seen"
   * snapshot. Caller is responsible for prior conflict-detection.
   */
  async push(entry: MirrorEntry): Promise<MirrorEntry> {
    const data = await fs.readFile(entry.localPath);
    const server = this.config.config.servers.find(s => s.name === entry.serverName);
    if (!server) {
      throw new Error(`Unknown server '${entry.serverName}'`);
    }
    const conn = await this.registry.ensure(server);
    // Auto-backup the pre-push remote version. mirror.push is a "save
    // local edits back" operation — backup wraps the prior remote state
    // so an operator who realises they pushed the wrong file can
    // recover from <backupDir>/<ts>_<basename>.
    const backupCmd = buildSftpBackupCommand(entry.remotePath, this.config.config.safety.autoBackup);
    if (backupCmd) {
      const r = await runRemoteCommand(conn, backupCmd, { timeoutMs: 30_000 });
      if (r.exitCode !== 0) {
        throw new Error(`auto-backup failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`}`);
      }
    }
    await conn.sftp.writeFile(entry.remotePath, data);
    // Re-stat to pick up the mtime the remote actually wrote.
    const stat = await conn.sftp.stat(entry.remotePath);

    const updated: MirrorEntry = {
      ...entry,
      downloadedAt: Date.now(),
      remoteMtimeAtDownload: stat.mtime,
      remoteSizeAtDownload: stat.size,
      contentHashAtDownload: sha256(data)
    };
    const m = this.read();
    m[entry.localPath] = updated;
    await this.write(m);
    log.info(`Mirror: pushed ${entry.localPath} -> ${entry.serverName}:${entry.remotePath}`);
    this.emitter.fire(updated);
    return updated;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
