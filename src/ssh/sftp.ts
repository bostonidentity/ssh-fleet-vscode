import type { SFTPWrapper, Stats } from 'ssh2';
import type { SshConnection } from './connection.js';

/**
 * Classify a thrown SFTP/SSH error into the three buckets that callers
 * actually care about — file genuinely missing, denied by the remote,
 * everything else. Prefer `code` (numeric SSH_FX_* per RFC draft) and fall
 * back to message regex only when the code is missing (some ssh2 paths
 * synthesize Errors without it).
 */
export type SftpErrorKind = 'enoent' | 'eacces' | 'other';
export function classifySftpError(err: unknown): SftpErrorKind {
  const code = (err as { code?: string | number }).code;
  if (typeof code === 'number') {
    if (code === 2) return 'enoent';
    if (code === 3) return 'eacces';
    return 'other';
  }
  const msg = (err as Error).message ?? String(err);
  if (/no such file|enoent/i.test(msg)) return 'enoent';
  if (/permission/i.test(msg)) return 'eacces';
  return 'other';
}
export function isSftpEnoent(err: unknown): boolean {
  return classifySftpError(err) === 'enoent';
}

export interface SftpStat {
  size: number;
  mtime: number;
  ctime: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

interface SftpEntry {
  filename: string;
  attrs: Stats;
}

function toStat(attrs: Stats): SftpStat {
  return {
    size: attrs.size ?? 0,
    mtime: (attrs.mtime ?? 0) * 1000,
    ctime: (attrs.atime ?? 0) * 1000,
    isDirectory: attrs.isDirectory(),
    isFile: attrs.isFile(),
    isSymbolicLink: attrs.isSymbolicLink()
  };
}

/**
 * Promisified SFTP wrapper bound to a single SshConnection.
 * The underlying SFTPWrapper is lazy-initialised on first use and cached
 * for the lifetime of the connection.
 */
export class SshSftp {
  private wrapper: SFTPWrapper | undefined;
  private opening: Promise<SFTPWrapper> | undefined;

  constructor(private readonly connection: SshConnection) {}

  private async ensure(): Promise<SFTPWrapper> {
    if (this.wrapper) {
      return this.wrapper;
    }
    if (this.connection.state !== 'connected') {
      // Failing fast here gives a much better message than ssh2's terse
      // "Not connected" string. Surfaces the actual connection state so
      // operators know whether to retry, re-auth, or look at the logs.
      const detail = this.connection.errorMessage ? `: ${this.connection.errorMessage}` : '';
      throw new Error(
        `SSH connection to ${this.connection.server.name} is ${this.connection.state}${detail} — cannot open SFTP channel`
      );
    }
    if (!this.opening) {
      this.opening = new Promise<SFTPWrapper>((resolve, reject) => {
        this.connection.client.sftp((err, sftp) => {
          if (err) {
            this.opening = undefined;
            reject(err);
            return;
          }
          this.wrapper = sftp;
          sftp.on('close', () => {
            this.wrapper = undefined;
            this.opening = undefined;
          });
          resolve(sftp);
        });
      });
    }
    return this.opening;
  }

  async stat(path: string): Promise<SftpStat> {
    const sftp = await this.ensure();
    return new Promise<SftpStat>((resolve, reject) => {
      sftp.stat(path, (err, attrs) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(toStat(attrs));
      });
    });
  }

  async lstat(path: string): Promise<SftpStat> {
    const sftp = await this.ensure();
    return new Promise<SftpStat>((resolve, reject) => {
      sftp.lstat(path, (err, attrs) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(toStat(attrs));
      });
    });
  }

  async readdir(path: string): Promise<{ name: string; stat: SftpStat }[]> {
    const sftp = await this.ensure();
    return new Promise((resolve, reject) => {
      sftp.readdir(path, (err, list) => {
        if (err) {
          reject(err);
          return;
        }
        const entries: SftpEntry[] = list as unknown as SftpEntry[];
        resolve(entries.map(e => ({ name: e.filename, stat: toStat(e.attrs) })));
      });
    });
  }

  async readFile(path: string): Promise<Buffer> {
    const sftp = await this.ensure();
    return new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(path, (err, data) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(data);
      });
    });
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    const sftp = await this.ensure();
    return new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, data, err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async unlink(path: string): Promise<void> {
    const sftp = await this.ensure();
    return new Promise<void>((resolve, reject) => {
      sftp.unlink(path, err => err ? reject(err) : resolve());
    });
  }

  async rmdir(path: string): Promise<void> {
    const sftp = await this.ensure();
    return new Promise<void>((resolve, reject) => {
      sftp.rmdir(path, err => err ? reject(err) : resolve());
    });
  }

  async mkdir(path: string): Promise<void> {
    const sftp = await this.ensure();
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, err => err ? reject(err) : resolve());
    });
  }

  /**
   * Recursive `mkdir -p`. Walks the path from the root, creating each
   * missing component. Already-existing directories are silently
   * accepted; non-directory collisions surface as the caller's error.
   * POSIX-only paths (the remote is always *nix here).
   */
  async mkdirP(remoteDir: string): Promise<void> {
    if (!remoteDir.startsWith('/')) {
      throw new Error(`mkdirP needs an absolute path, got: ${remoteDir}`);
    }
    const parts = remoteDir.split('/').filter(p => p.length > 0);
    let cur = '';
    for (const part of parts) {
      cur += '/' + part;
      try {
        const st = await this.stat(cur);
        if (!st.isDirectory) {
          throw new Error(`${cur} exists and is not a directory`);
        }
      } catch (err) {
        // Only "file genuinely missing" justifies trying to create. Any
        // other failure (permission, transport, generic) must propagate so
        // the caller surfaces a real error instead of silently mkdir-ing
        // through a permission denial.
        if (!isSftpEnoent(err)) {
          throw err;
        }
        await this.mkdir(cur);
      }
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const sftp = await this.ensure();
    return new Promise<void>((resolve, reject) => {
      sftp.rename(oldPath, newPath, err => err ? reject(err) : resolve());
    });
  }

  dispose(): void {
    this.wrapper?.end();
    this.wrapper = undefined;
    this.opening = undefined;
  }
}
