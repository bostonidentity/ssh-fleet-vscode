import * as vscode from 'vscode';

const PREFIX = 'ssh-fleet:';

export class SecretStore {
  /**
   * Tail of the prompt-serialisation chain. VSCode's `showInputBox` is
   * effectively a global singleton — a second call closes the first with
   * `undefined`. When multiple servers connect in parallel, each calls
   * `getOrPrompt` concurrently and only one survives. Chaining promise
   * tails forces each caller to wait until the previous prompt fully
   * resolves (or rejects) before showing its own box.
   *
   * Errors are caught into `undefined` so a single failure doesn't
   * deadlock all subsequent callers.
   */
  private promptTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(ref: string): Promise<string | undefined> {
    return this.secrets.get(PREFIX + ref);
  }

  async set(ref: string, value: string): Promise<void> {
    await this.secrets.store(PREFIX + ref, value);
  }

  async delete(ref: string): Promise<void> {
    await this.secrets.delete(PREFIX + ref);
  }

  async getOrPrompt(ref: string, prompt: string): Promise<string | undefined> {
    const existing = await this.get(ref);
    if (existing !== undefined) {
      return existing;
    }
    const myPrompt = this.promptTail.then(async () => {
      // Re-check inside the queue: another caller may have already
      // stored this same ref (e.g. several servers sharing one
      // passwordRef like an LDAP fleet password) — short-circuit.
      const cached = await this.get(ref);
      if (cached !== undefined) {
        return cached;
      }
      const entered = await vscode.window.showInputBox({
        prompt,
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'value will be stored in the system keychain'
      });
      if (entered !== undefined) {
        await this.set(ref, entered);
      }
      return entered;
    });
    // Advance the queue tail; swallow errors so they don't poison
    // future calls.
    this.promptTail = myPrompt.catch(() => undefined);
    return myPrompt;
  }

  /**
   * Prompt for a one-time credential that is NEVER read from or written
   * to the OS keychain. Used for OTP / TOTP / dynamic-password auth where
   * caching would be functionally wrong (cached value always stale) — and
   * for `cachePassword: false` servers where caching is policy-banned.
   *
   * Shares the same prompt queue as `getOrPrompt` so multiple concurrent
   * connects don't fight over VSCode's singleton input box.
   */
  async promptEphemeral(prompt: string): Promise<string | undefined> {
    const myPrompt = this.promptTail.then(() =>
      vscode.window.showInputBox({
        prompt,
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'one-time code (not cached)'
      })
    );
    this.promptTail = myPrompt.catch(() => undefined);
    return myPrompt;
  }
}
