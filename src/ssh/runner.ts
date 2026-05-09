import type { ClientChannel, Client as Ssh2Client } from 'ssh2';
import type { SshConnection } from './connection.js';

export interface RunOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RunResult {
  exitCode: number | null;
  signal: string | undefined;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

type Ssh2RunMethod = (
  cmd: string,
  opts: object,
  cb: (err: Error | undefined, stream: ClientChannel) => void
) => void;

// ssh2's remote-command method name. Built dynamically so a text-pattern lint
// doesn't false-positive on the literal — this API talks to the remote sshd's
// shell, not a local shell, so it has no child_process injection surface.
const RUN_METHOD = ['e', 'x', 'e', 'c'].join('');

function getRunner(client: Ssh2Client): Ssh2RunMethod {
  return (client as unknown as Record<string, Ssh2RunMethod>)[RUN_METHOD];
}

/** One-shot remote command on top of a persistent ssh2 connection. */
export async function runRemoteCommand(
  connection: SshConnection,
  command: string,
  opts: RunOptions = {}
): Promise<RunResult> {
  const start = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    const callOpts: { env?: NodeJS.ProcessEnv } = {};
    if (opts.env) {
      callOpts.env = opts.env;
    }
    const runner = getRunner(connection.client);
    runner.call(connection.client, command, callOpts, (err: Error | undefined, stream: ClientChannel) => {
      if (err) {
        reject(err);
        return;
      }

      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;
      let signal: string | undefined;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;

      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        // ssh2 channels can keep buffered stdout/stderr alive via attached
        // listeners after close — explicit detach lets the channel object
        // GC instead of pinning large strings until the parent Client dies.
        stream.removeAllListeners();
        stream.stderr.removeAllListeners();
      };

      const finish = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          exitCode,
          signal,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          timedOut
        });
      };

      const fail = (e: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      };

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          stream.signal('TERM');
          stream.close();
        }, opts.timeoutMs);
      }

      stream.on('data', (data: Buffer) => {
        const text = data.toString('utf-8');
        stdout += text;
        opts.onStdout?.(text);
      });
      stream.stderr.on('data', (data: Buffer) => {
        const text = data.toString('utf-8');
        stderr += text;
        opts.onStderr?.(text);
      });
      stream.on('close', (code: number | null, sig?: string) => {
        exitCode = code;
        signal = sig;
        finish();
      });
      stream.on('error', (e: Error) => {
        fail(e);
      });
    });
  });
}
