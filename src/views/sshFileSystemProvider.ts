import * as vscode from 'vscode';
import type { ConnectionRegistry } from '../ssh/connection.js';
import type { ConfigStore } from '../config/loader.js';
import { classifySftpError, isSftpEnoent, type SshSftp, type SftpStat } from '../ssh/sftp.js';
import { log } from '../util/logger.js';

export const SCHEME = 'ssh-fleet';

interface ParsedUri {
  serverName: string;
  remotePath: string;
}

function parseUri(uri: vscode.Uri): ParsedUri {
  if (uri.scheme !== SCHEME) {
    throw new Error(`expected ${SCHEME}:// URI, got ${uri.scheme}://`);
  }
  if (!uri.authority) {
    throw new Error(`${SCHEME}:// URI is missing the server name (authority)`);
  }
  return {
    serverName: uri.authority,
    remotePath: uri.path === '' ? '/' : uri.path
  };
}

export function buildUri(serverName: string, remotePath: string): vscode.Uri {
  const path = remotePath.startsWith('/') ? remotePath : '/' + remotePath;
  return vscode.Uri.from({ scheme: SCHEME, authority: serverName, path });
}

function fileTypeFor(stat: SftpStat): vscode.FileType {
  if (stat.isSymbolicLink) {
    return vscode.FileType.SymbolicLink | (stat.isDirectory ? vscode.FileType.Directory : vscode.FileType.File);
  }
  if (stat.isDirectory) {
    return vscode.FileType.Directory;
  }
  return vscode.FileType.File;
}

function mapError(err: unknown, uri: vscode.Uri, op: string): vscode.FileSystemError {
  const code = (err as { code?: string | number }).code;
  const message = (err as Error).message ?? String(err);
  // VSCode's File Explorer turns FSP errors into a silent yellow ! with no
  // popup. Always log to OutputChannel so the operator has SOMETHING to look
  // at when a mounted folder appears empty.
  log.warn(`FSP ${op} failed on ${uri.toString()} (code=${String(code)}): ${message}`);
  // The FileSystemProvider contract requires FileSystemError instances —
  // a plain Error becomes an unhandled rejection in some VSCode versions.
  switch (classifySftpError(err)) {
    case 'enoent': return vscode.FileSystemError.FileNotFound(uri);
    case 'eacces': return vscode.FileSystemError.NoPermissions(uri);
    default: return vscode.FileSystemError.Unavailable(`SFTP ${op}: ${message}`);
  }
}

function unavailable(uri: vscode.Uri, msg: string): vscode.FileSystemError {
  return vscode.FileSystemError.Unavailable(`${uri.toString()}: ${msg}`);
}

/**
 * VSCode FileSystemProvider over SSH/SFTP.
 *
 * Each `ssh-fleet://<server-name>/<path>` URI resolves to the SSH connection for
 * that server (auto-connects on demand) and proxies all VFS operations through
 * an SFTPWrapper channel. The same connection backs interactive Terminals and
 * batch broadcasts simultaneously — SFTP is just a third channel on the same Client.
 */
export class SshFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  /**
   * Mtime of each remote file the moment we last read it — used to warn the
   * user if the remote changed externally between read and save.
   */
  private readonly lastSeenMtime = new Map<string, number>();

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly config: ConfigStore
  ) {}

  private async sftpFor(serverName: string): Promise<SshSftp> {
    const server = this.config.config.servers.find(s => s.name === serverName);
    if (!server) {
      throw vscode.FileSystemError.FileNotFound(`server '${serverName}' not in config`);
    }
    const conn = await this.registry.ensure(server);
    return conn.sftp;
  }

  watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: readonly string[] }): vscode.Disposable {
    // SFTP has no native file-watch — emit nothing. Save round-trips suffice.
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { serverName, remotePath } = parseUri(uri);
    let sftp: SshSftp;
    try {
      sftp = await this.sftpFor(serverName);
    } catch (err) {
      log.warn(`FSP stat: cannot open SFTP for ${serverName} — ${(err as Error).message}`);
      throw unavailable(uri, `cannot connect to ${serverName} — ${(err as Error).message}`);
    }
    try {
      const s = await sftp.stat(remotePath);
      return {
        type: fileTypeFor(s),
        size: s.size,
        mtime: s.mtime,
        ctime: s.ctime
      };
    } catch (err) {
      throw mapError(err, uri, 'stat');
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { serverName, remotePath } = parseUri(uri);
    let sftp: SshSftp;
    try {
      sftp = await this.sftpFor(serverName);
    } catch (err) {
      log.warn(`FSP readDirectory: cannot open SFTP for ${serverName} — ${(err as Error).message}`);
      throw unavailable(uri, `cannot connect to ${serverName} — ${(err as Error).message}`);
    }
    try {
      const entries = await sftp.readdir(remotePath);
      log.info(`FSP readDirectory ${serverName}:${remotePath} -> ${entries.length} entries`);
      return entries.map(e => [e.name, fileTypeFor(e.stat)] as [string, vscode.FileType]);
    } catch (err) {
      throw mapError(err, uri, 'readdir');
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { serverName, remotePath } = parseUri(uri);
    const sftp = await this.sftpFor(serverName);
    try {
      const buf = await sftp.readFile(remotePath);
      try {
        const stat = await sftp.stat(remotePath);
        this.lastSeenMtime.set(uri.toString(), stat.mtime);
      } catch (err) {
        // stat failure on read isn't fatal — but log it. Without a recorded
        // mtime, the next save's conflict-detection silently disables.
        log.warn(`FSP readFile mtime probe failed for ${uri.toString()}: ${(err as Error).message}`);
      }
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      throw mapError(err, uri, 'readFile');
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    const { serverName, remotePath } = parseUri(uri);
    const sftp = await this.sftpFor(serverName);
    let existed = true;
    let currentMtime: number | undefined;
    try {
      const stat = await sftp.stat(remotePath);
      currentMtime = stat.mtime;
    } catch (err) {
      // Only "file genuinely missing" justifies treating this as a create.
      // Permission-denied / transport-broken stats here would otherwise
      // make the conflict-detection check silently no-op and let the real
      // writeFile fail with the same error the user just hit invisibly.
      if (!isSftpEnoent(err)) {
        throw mapError(err, uri, 'writeFile-stat');
      }
      existed = false;
    }
    if (existed && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (!existed && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    // Mtime conflict guard: if the remote file is newer than the last time
    // we read it, someone else changed it — warn before overwriting.
    if (existed && currentMtime !== undefined) {
      const seen = this.lastSeenMtime.get(uri.toString());
      if (seen !== undefined && currentMtime > seen) {
        const proceed = await vscode.window.showWarningMessage(
          `Remote ${remotePath} on ${serverName} was modified since you opened it. Overwrite anyway?`,
          { modal: true },
          'Overwrite'
        );
        if (proceed !== 'Overwrite') {
          throw new Error('Save cancelled — remote was modified externally');
        }
      }
    }

    try {
      await sftp.writeFile(remotePath, Buffer.from(content));
      // Update our snapshot so the next save round-trip starts clean.
      try {
        const stat = await sftp.stat(remotePath);
        this.lastSeenMtime.set(uri.toString(), stat.mtime);
      } catch (err) {
        // Non-fatal — bytes are on disk. But the missing mtime means the
        // next save's conflict-detection silently disables; surface that.
        log.warn(`FSP writeFile mtime probe failed for ${uri.toString()}: ${(err as Error).message}`);
      }
      this.emitter.fire([{
        type: existed ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created,
        uri
      }]);
    } catch (err) {
      throw mapError(err, uri, 'writeFile');
    }
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const { serverName, remotePath } = parseUri(uri);
    const sftp = await this.sftpFor(serverName);
    try {
      const s = await sftp.stat(remotePath);
      if (s.isDirectory) {
        if (!options.recursive) {
          await sftp.rmdir(remotePath);
        } else {
          await this.recursiveDelete(sftp, remotePath);
        }
      } else {
        await sftp.unlink(remotePath);
      }
      this.lastSeenMtime.delete(uri.toString());
      this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    } catch (err) {
      throw mapError(err, uri, 'delete');
    }
  }

  private async recursiveDelete(sftp: SshSftp, remotePath: string): Promise<void> {
    const entries = await sftp.readdir(remotePath);
    for (const e of entries) {
      const child = remotePath.replace(/\/$/, '') + '/' + e.name;
      if (e.stat.isDirectory) {
        await this.recursiveDelete(sftp, child);
      } else {
        await sftp.unlink(child);
      }
    }
    await sftp.rmdir(remotePath);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    const oldP = parseUri(oldUri);
    const newP = parseUri(newUri);
    if (oldP.serverName !== newP.serverName) {
      throw new Error('Cross-server rename is not supported');
    }
    const sftp = await this.sftpFor(oldP.serverName);
    if (!options.overwrite) {
      try {
        await sftp.stat(newP.remotePath);
        throw vscode.FileSystemError.FileExists(newUri);
      } catch (err) {
        if (err instanceof vscode.FileSystemError) {
          throw err;
        }
        // Only "target doesn't exist" justifies falling through to the
        // rename. Permission-denied / transport / other failures used to
        // be silently swallowed — that let the rename clobber a remote
        // file the operator didn't know was there. Surface every other
        // error via mapError so the operator sees it.
        if (!isSftpEnoent(err)) {
          throw mapError(err, newUri, 'rename-precheck');
        }
      }
    }
    try {
      await sftp.rename(oldP.remotePath, newP.remotePath);
      const seen = this.lastSeenMtime.get(oldUri.toString());
      this.lastSeenMtime.delete(oldUri.toString());
      if (seen !== undefined) {
        this.lastSeenMtime.set(newUri.toString(), seen);
      }
      this.emitter.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri }
      ]);
    } catch (err) {
      throw mapError(err, oldUri, 'rename');
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const { serverName, remotePath } = parseUri(uri);
    const sftp = await this.sftpFor(serverName);
    try {
      await sftp.mkdir(remotePath);
      this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
    } catch (err) {
      log.error(`mkdir failed: ${remotePath}`, err);
      throw mapError(err, uri, 'mkdir');
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
