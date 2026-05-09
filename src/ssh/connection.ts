import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
// Subpath import bypasses ssh2's `index.js`, which eagerly
// `require()`s server.js and keygen.js. We don't host SSH servers and
// don't generate keys here — going via client.js drops both branches
// from the bundled output and (importantly) from VS Marketplace's
// content scanner, which has a heuristic that flags extensions
// shipping SSH-server-side code.
// Type-only `ConnectConfig` still imports from `'ssh2'` so TS resolves
// the typings the package ships. Type imports erase at build time and
// don't affect the runtime require graph.
import Client from 'ssh2/lib/client.js';
import type { ConnectConfig } from 'ssh2';
import * as vscode from 'vscode';
import type { ServerConfig, ConnectionState } from '../config/types.js';
import type { SecretStore } from '../secrets/store.js';
import { log } from '../util/logger.js';
import { SshSftp } from './sftp.js';
import { verifyHostKey, type HostKeyStore } from './hostKeys.js';

/**
 * Sentinel error for "user explicitly cancelled an auth prompt" — separate
 * from real auth failures so the reconnect machinery can recognise it and
 * skip retry loops (otherwise an OTP user who hits Esc gets prompted
 * `maxAttempts` times in a row, with no escape).
 */
export class AuthCancelledError extends Error {
  constructor(message: string = 'Authentication cancelled by user') {
    super(message);
    this.name = 'AuthCancelledError';
  }
}

function parseKeyAlgorithm(buf: Buffer): string {
  if (buf.length < 4) {
    return 'unknown';
  }
  const len = buf.readUInt32BE(0);
  if (buf.length < 4 + len) {
    return 'unknown';
  }
  return buf.subarray(4, 4 + len).toString('utf-8');
}

async function promptKeyboardInteractive(
  serverName: string,
  name: string,
  instructions: string,
  prompts: { prompt: string; echo: boolean }[]
): Promise<string[] | undefined> {
  const responses: string[] = [];
  if (instructions) {
    void vscode.window.showInformationMessage(`SSH (${serverName}): ${instructions}`);
  }
  for (const p of prompts) {
    const value = await vscode.window.showInputBox({
      title: name ? `SSH (${serverName}) — ${name}` : `SSH (${serverName})`,
      prompt: p.prompt.replace(/[:\s]+$/, ''),
      password: !p.echo,
      ignoreFocusOut: true
    });
    if (value === undefined) {
      return undefined;
    }
    responses.push(value);
  }
  return responses;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Default key paths probed in order, mirroring OpenSSH. */
const DEFAULT_KEY_PATHS = [
  '~/.ssh/id_ed25519',
  '~/.ssh/id_rsa',
  '~/.ssh/id_ecdsa'
];

async function autoDetectKeyPath(): Promise<string | undefined> {
  // EACCES on one candidate doesn't mean we should give up — the user might
  // have id_ed25519 chmodded 000 (old/locked) AND a working id_rsa. Collect
  // inaccessible paths and only surface them if NO candidate is usable, so
  // the error message is actionable when there really is no readable key.
  const inaccessible: { path: string; code: string }[] = [];
  for (const candidate of DEFAULT_KEY_PATHS) {
    const expanded = expandHome(candidate);
    try {
      await fs.access(expanded);
      return expanded;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        inaccessible.push({ path: expanded, code });
      }
      // ENOENT (and any other shape) — just try next candidate silently.
    }
  }
  if (inaccessible.length > 0) {
    const detail = inaccessible.map(e => `${e.path} (${e.code})`).join(', ');
    throw new Error(
      `SSH key candidates exist but cannot be read: ${detail}. Check file permissions.`
    );
  }
  return undefined;
}

async function buildConnectConfig(
  server: ServerConfig,
  secrets: SecretStore,
  keepaliveSeconds: number,
  hostKeys: HostKeyStore
): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.user,
    keepaliveInterval: keepaliveSeconds * 1000,
    keepaliveCountMax: 3,
    readyTimeout: 20_000,
    tryKeyboard: true,
    // We bundle ssh2 with the WASM-based Poly1305 module stubbed out
    // (the WASM blob triggers VS Marketplace's content scanner). That
    // stub makes the chacha20-poly1305@openssh.com cipher non-functional
    // — invoking it at runtime throws. Negotiate around it by
    // ADVERTISING the cipher list ssh2 supports natively, minus chacha20.
    // Modern OpenSSH always offers AES-GCM/CTR ciphers, so this is
    // universally compatible.
    algorithms: {
      cipher: [
        'aes128-gcm',
        'aes128-gcm@openssh.com',
        'aes256-gcm',
        'aes256-gcm@openssh.com',
        'aes128-ctr',
        'aes192-ctr',
        'aes256-ctr'
      ]
    },
    hostVerifier: ((keyBuf: Buffer, callback: (valid: boolean) => void): void => {
      const algorithm = parseKeyAlgorithm(keyBuf);
      verifyHostKey(hostKeys, server.host, server.port, algorithm, keyBuf)
        .then(callback)
        .catch(err => {
          log.error(`Host key verification failed for ${server.name}`, err);
          callback(false);
        });
    }) as ConnectConfig['hostVerifier']
  };

  switch (server.auth.type) {
    case 'key': {
      let keyPath = server.auth.keyPath ? expandHome(server.auth.keyPath) : undefined;
      if (!keyPath) {
        keyPath = await autoDetectKeyPath();
        if (!keyPath) {
          // Fall through to agent if available — matches OpenSSH default behaviour.
          const sock = process.env.SSH_AUTH_SOCK;
          if (sock) {
            log.info(`No SSH key found for ${server.name}; falling back to agent`);
            return { ...base, agent: sock };
          }
          throw new Error(`No SSH key configured and none auto-detected at ${DEFAULT_KEY_PATHS.join(', ')}`);
        }
        log.info(`Auto-detected SSH key for ${server.name}: ${keyPath}`);
      }
      const privateKey = await fs.readFile(keyPath);
      const cfg: ConnectConfig = { ...base, privateKey };
      if (server.auth.passphraseRef) {
        const phrase = await secrets.getOrPrompt(
          server.auth.passphraseRef,
          `Passphrase for ${keyPath}`
        );
        if (phrase) {
          cfg.passphrase = phrase;
        }
      }
      return cfg;
    }
    case 'password': {
      // Three modes:
      //   1. cachePassword === false: prompt every connect, never read or
      //      write the keychain. Use this for OTP / TOTP / dynamic-
      //      password servers where caching would always be stale.
      //   2. Plaintext password in YAML: legacy compat — use it directly,
      //      no prompt, no caching.
      //   3. Default: ref-based caching via SecretStorage. Auto-derives
      //      ref `<name>-password` when neither password nor passwordRef
      //      is given (matches compat.ts's ENC(...) migration convention).
      let password: string | undefined;
      if (server.auth.cachePassword === false) {
        if (server.auth.password) {
          log.warn(
            `${server.name}: plaintext 'password' in YAML is ignored when cachePassword:false ` +
            `is set. Remove it to silence this warning.`
          );
        }
        password = await secrets.promptEphemeral(
          `Authentication code for ${server.user}@${server.host} (not cached — OTP / dynamic password)`
        );
        if (password === undefined) {
          // User dismissed the OTP / dynamic-password prompt. Treat as
          // explicit cancel so the reconnect machinery doesn't loop the
          // prompt `maxAttempts` times in a row.
          throw new AuthCancelledError();
        }
      } else if (server.auth.password) {
        password = server.auth.password;
      } else {
        const ref = server.auth.passwordRef ?? `${server.name}-password`;
        password = await secrets.getOrPrompt(
          ref,
          `Password for ${server.user}@${server.host}`
        );
        if (password === undefined) {
          throw new AuthCancelledError();
        }
      }
      if (!password) {
        throw new Error('Password not provided');
      }
      return { ...base, password };
    }
    case 'agent': {
      const sock = process.env.SSH_AUTH_SOCK;
      if (!sock) {
        throw new Error('agent auth requested but SSH_AUTH_SOCK is not set');
      }
      return { ...base, agent: sock };
    }
    default: {
      const exhaustive: never = server.auth;
      throw new Error(`unknown auth type: ${(exhaustive as { type: string }).type}`);
    }
  }
}

export interface ReconnectOptions {
  enabled: boolean;
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

const RECONNECT_DEFAULTS: ReconnectOptions = {
  enabled: true,
  maxAttempts: 6,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000
};

export class SshConnection {
  client = new Client();
  private _state: ConnectionState = 'idle';
  private _error: string | undefined;
  private readyResolved = false;
  private _sftp: SshSftp | undefined;
  private userInitiatedDisconnect = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private lastConfig: { secrets: SecretStore; keepaliveSeconds: number } | undefined;
  /**
   * Shared promise for an in-flight connect() so concurrent callers all
   * await the SAME handshake. Without this, the second caller would see
   * state='connecting' and resolve immediately against a not-yet-ready
   * Client — producing the infamous "Not connected" error from
   * `client.sftp()` because `_sock` isn't writable yet.
   */
  private connectInFlight: Promise<void> | undefined;

  private readonly stateEmitter = new vscode.EventEmitter<ConnectionState>();
  readonly onStateChange = this.stateEmitter.event;

  constructor(
    readonly server: ServerConfig,
    private readonly hostKeys: HostKeyStore,
    private readonly reconnect: ReconnectOptions = RECONNECT_DEFAULTS
  ) {}

  get sftp(): SshSftp {
    if (!this._sftp) {
      this._sftp = new SshSftp(this);
    }
    return this._sftp;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get errorMessage(): string | undefined {
    return this._error;
  }

  private setState(s: ConnectionState, errorMessage?: string): void {
    this._state = s;
    this._error = errorMessage;
    this.stateEmitter.fire(s);
  }

  async connect(secrets: SecretStore, keepaliveSeconds: number): Promise<void> {
    if (this._state === 'connected') {
      return;
    }
    if (this.connectInFlight) {
      // Another caller is already mid-handshake — share their promise.
      return this.connectInFlight;
    }
    this.connectInFlight = this._doConnect(secrets, keepaliveSeconds).finally(() => {
      this.connectInFlight = undefined;
    });
    return this.connectInFlight;
  }

  private async _doConnect(secrets: SecretStore, keepaliveSeconds: number): Promise<void> {
    this.lastConfig = { secrets, keepaliveSeconds };
    this.userInitiatedDisconnect = false;
    this.readyResolved = false;
    // A queued reconnect timer from a prior cycle must not fire across a
    // fresh connect attempt — clear it before starting.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.setState('connecting');
    // Wrap the pre-handshake await so a thrown error here (key file
    // unreadable, OTP prompt cancelled, etc.) doesn't leave _state stuck
    // at 'connecting' — the TreeView would otherwise spin forever until
    // the next ensure() call kicks a fresh attempt.
    let config: ConnectConfig;
    try {
      config = await buildConnectConfig(this.server, secrets, keepaliveSeconds, this.hostKeys);
    } catch (err) {
      // AuthCancelledError → user explicitly opted out: no retry, no
      // background reconnect timer, drop to idle so the icon shows the
      // intent. Other errors → 'error' so the operator sees what broke.
      if (err instanceof AuthCancelledError) {
        this.userInitiatedDisconnect = true;
        this.setState('idle');
      } else {
        this.setState('error', (err as Error).message);
      }
      throw err;
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let kbiCancelled = false;
      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleReject = (err: Error): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const onKeyboardInteractive = (
        name: string,
        instructions: string,
        _lang: string,
        prompts: { prompt: string; echo: boolean }[],
        finish: (responses: string[]) => void
      ): void => {
        promptKeyboardInteractive(this.server.name, name, instructions, prompts)
          .then(responses => {
            if (responses === undefined) {
              // User dismissed the prompt. Mark cancelled so the upcoming
              // ssh2 'auth failed' error gets translated into the
              // friendlier "cancelled by user" message + skips reconnect.
              kbiCancelled = true;
              finish([]);
            } else {
              finish(responses);
            }
          })
          .catch(err => {
            log.error(`keyboard-interactive prompt failed on ${this.server.name}`, err);
            finish([]);
          });
      };

      const onReady = (): void => {
        this.readyResolved = true;
        this.reconnectAttempt = 0;
        this.setState('connected');
        log.info(`Connected to ${this.server.name}`);
        settleResolve();
      };
      const onError = (err: Error): void => {
        // Translate ssh2's generic auth-failed message into a more useful
        // one when the operator pressed Esc on a keyboard-interactive
        // prompt. Otherwise they'd see "All configured authentication
        // methods failed" with no hint that THEY caused it.
        const finalErr = kbiCancelled
          ? new AuthCancelledError('Authentication cancelled — keyboard-interactive prompt dismissed')
          : err;
        log.error(`SSH error on ${this.server.name}`, finalErr);
        if (!this.readyResolved) {
          // Pre-ready failure: state goes to error/idle and the connect
          // promise rejects. Cancellation routes to idle (intentional) so
          // the icon shows operator intent, not a fatal red.
          if (finalErr instanceof AuthCancelledError) {
            this.userInitiatedDisconnect = true;
            this.setState('idle');
          } else {
            this.setState('error', finalErr.message);
          }
          settleReject(finalErr);
        } else {
          // Post-ready: connection died after a successful handshake. Set
          // error state AND trigger reconnect (onClose may not fire the
          // reconnect path because by the time it sees state, it's already
          // 'error' and wasConnected reads false).
          this.setState('error', finalErr.message);
          if (!this.userInitiatedDisconnect && this.reconnect.enabled) {
            this.scheduleReconnect();
          }
        }
      };
      const onClose = (): void => {
        log.info(`Connection closed: ${this.server.name}`);
        const wasConnected = this._state === 'connected';
        this._sftp?.dispose();
        this._sftp = undefined;
        if (this._state !== 'error') {
          this.setState('idle');
        }
        // Critical: ssh2 has paths where `'close'` fires alone (server sends
        // DISCONNECT cleanly during auth, etc.). Without this, the connect
        // promise would hang forever and every subsequent ensure() would
        // await the dead promise.
        if (!this.readyResolved) {
          settleReject(new Error('SSH connection closed before authentication completed'));
        }
        // wasConnected captures the pre-cleanup state so onError having
        // flipped to 'error' first doesn't break reconnect logic. The
        // && !this.reconnectTimer guard prevents double-scheduling when
        // onError already armed a reconnect.
        if (
          !this.userInitiatedDisconnect &&
          wasConnected &&
          this.reconnect.enabled &&
          !this.reconnectTimer
        ) {
          this.scheduleReconnect();
        }
      };

      // ssh2 typings omit 'keyboard-interactive' from Client.on overloads — cast through.
      (this.client as unknown as { on(ev: string, l: (...a: unknown[]) => void): void })
        .on('keyboard-interactive', onKeyboardInteractive as (...a: unknown[]) => void);
      // 'ready' fires once per Client (we make a new Client on reconnect) —
      // .once keeps the handler set tidy. 'error' / 'close' must stay live
      // post-ready so reconnect logic can trigger.
      this.client.once('ready', onReady);
      this.client.on('error', onError);
      this.client.on('close', onClose);

      try {
        this.client.connect(config);
      } catch (err) {
        this.setState('error', (err as Error).message);
        settleReject(err as Error);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= this.reconnect.maxAttempts || !this.lastConfig) {
      log.warn(`Reconnect giving up on ${this.server.name} after ${this.reconnectAttempt} attempts`);
      return;
    }
    const attempt = this.reconnectAttempt + 1;
    const delay = Math.min(
      this.reconnect.initialDelayMs * 2 ** (attempt - 1),
      this.reconnect.maxDelayMs
    );
    log.info(`Reconnecting to ${this.server.name} in ${delay}ms (attempt ${attempt}/${this.reconnect.maxAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempt = attempt;
      this.client = new Client();
      const cfg = this.lastConfig;
      if (!cfg) {
        return;
      }
      this.connect(cfg.secrets, cfg.keepaliveSeconds).catch(err => {
        log.warn(`Reconnect attempt ${attempt} failed: ${(err as Error).message}`);
        this.scheduleReconnect();
      });
    }, delay);
  }

  disconnect(): void {
    if (this._state === 'idle') {
      return;
    }
    this.userInitiatedDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this._sftp?.dispose();
    this._sftp = undefined;
    this.client.end();
    this.setState('idle');
  }

  dispose(): void {
    this.disconnect();
    this.stateEmitter.dispose();
  }
}

/** Owns all live SshConnection instances, keyed by server name. */
export class ConnectionRegistry implements vscode.Disposable {
  private readonly conns = new Map<string, SshConnection>();
  private readonly emitter = new vscode.EventEmitter<string>();
  readonly onChange = this.emitter.event;

  constructor(
    private readonly secrets: SecretStore,
    private readonly hostKeys: HostKeyStore,
    private readonly settings: { keepaliveSeconds: number }
  ) {}

  get(name: string): SshConnection | undefined {
    return this.conns.get(name);
  }

  list(): SshConnection[] {
    return [...this.conns.values()];
  }

  connectedCount(): number {
    return this.list().filter(c => c.state === 'connected').length;
  }

  async ensure(server: ServerConfig): Promise<SshConnection> {
    let conn = this.conns.get(server.name);
    if (!conn) {
      conn = new SshConnection(server, this.hostKeys);
      conn.onStateChange(() => this.emitter.fire(server.name));
      this.conns.set(server.name, conn);
    }
    if (conn.state !== 'connected') {
      await conn.connect(this.secrets, this.settings.keepaliveSeconds);
    }
    return conn;
  }

  disconnect(name: string): void {
    const conn = this.conns.get(name);
    if (conn) {
      conn.disconnect();
      this.conns.delete(name);
      conn.dispose();
      this.emitter.fire(name);
    }
  }

  disconnectAll(): void {
    for (const name of [...this.conns.keys()]) {
      this.disconnect(name);
    }
  }

  dispose(): void {
    this.disconnectAll();
    this.emitter.dispose();
  }
}
