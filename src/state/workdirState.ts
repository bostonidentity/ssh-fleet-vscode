import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Workspace } from '../workspace.js';
import { log } from '../util/logger.js';

/**
 * File-backed state store that lives inside the SSH Fleet workdir at
 * `<workdir>/.ssh-fleet-state.json`. Implements the `vscode.Memento`
 * surface (`get` / `update` / `keys`) so existing consumers
 * (`SelectionState`, `ServerFilterState`) can swap from `globalState`
 * to this without API changes.
 *
 * Why this exists alongside `globalState`: VS Code's `globalState` lives
 * under the user profile (`%APPDATA%/Code/User/...` on Windows). In
 * environments that reset the user profile between sessions, that
 * storage is wiped repeatedly. By writing the same data into the
 * workdir — which the operator can place on persistent storage
 * (network drive / OneDrive / mapped home folder) — state survives
 * profile resets without depending on platform specifics.
 *
 * The fallback layer uses `globalState` when the workdir isn't set
 * yet (e.g. before the first-run wizard) so callers always have a
 * working `Memento`.
 */
export class WorkdirStateStore implements vscode.Memento {
  private cache: Record<string, unknown> = {};
  private loaded = false;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  /** 200ms debounce keeps tight tick→tick→tick bursts (e.g. operator
   *  ticking five servers in quick succession) from writing the file
   *  five times. The cost is up to 200ms of write lag if VS Code crashes
   *  immediately after a state change — acceptable since the data
   *  involved (selection / filter / ls flags) is operator-recoverable. */
  private static readonly DEBOUNCE_MS = 200;

  constructor(
    private readonly workspace: Workspace,
    private readonly fallback: vscode.Memento
  ) {}

  /** Path to the on-disk JSON file, or `undefined` if no workdir set. */
  private filePath(): string | undefined {
    const root = this.workspace.root;
    return root ? path.join(root, '.ssh-fleet-state.json') : undefined;
  }

  /** Lazy hydrate on first `get`. Synchronous for the rest of the run —
   *  cache acts as the source of truth and writes go through `update`. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const fp = this.filePath();
    if (!fp) {
      this.loaded = true;
      return;
    }
    try {
      const txt = await fs.readFile(fp, 'utf-8');
      const parsed = JSON.parse(txt);
      if (parsed && typeof parsed === 'object') {
        this.cache = parsed as Record<string, unknown>;
        log.info(`WorkdirState: loaded ${Object.keys(this.cache).length} key(s) from ${fp}`);
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        log.warn(`WorkdirState: failed to read ${fp}: ${e.message}`);
      } else {
        log.info(`WorkdirState: ${fp} doesn't exist yet (fresh workdir)`);
      }
    }
    this.loaded = true;
  }

  keys(): readonly string[] {
    return Object.keys(this.cache);
  }

  /** Memento-shaped get. The interface is sync, so we serve from the
   *  in-memory cache. Hydration happens on first activation via
   *  `hydrateAsync()` — we can't await inside a sync API, so callers
   *  that need fresh-start semantics MUST call hydrateAsync() once at
   *  startup. */
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (key in this.cache) return this.cache[key] as T;
    // Fallback: read from globalState. Useful for first-run migration
    // (operator had state in globalState before this store existed).
    const fb = this.fallback.get<T>(key);
    if (fb !== undefined) return fb;
    return defaultValue;
  }

  /** Memento-shaped update. Writes go to the in-memory cache
   *  synchronously, then debounce-flush to disk. */
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      delete this.cache[key];
    } else {
      this.cache[key] = value;
    }
    // Mirror to globalState so persistent-profile machines also keep
    // state — gives operators a smooth migration path either way.
    void this.fallback.update(key, value);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => void this.flush(), WorkdirStateStore.DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    this.writeTimer = undefined;
    const fp = this.filePath();
    if (!fp) return; // no workdir yet, only fallback was updated
    try {
      // Atomic write: stage to a `.tmp` neighbour, then rename. Avoids a
      // partial-write race if VS Code crashes mid-save (the .tmp may
      // exist but the canonical file remains valid).
      const tmp = fp + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2), 'utf-8');
      await fs.rename(tmp, fp);
    } catch (err) {
      log.warn(`WorkdirState: failed to write ${fp}: ${(err as Error).message}`);
    }
  }

  /** Explicit hydrate — call once at extension activation so the cache
   *  is warm before any consumer reads it. */
  async hydrateAsync(): Promise<void> {
    await this.ensureLoaded();
  }

  /** Re-hydrate when the workdir changes (operator runs Switch
   *  Workspace). Drops the cache and re-reads from the new location. */
  async onWorkspaceRootChanged(): Promise<void> {
    this.cache = {};
    this.loaded = false;
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    await this.ensureLoaded();
  }
}
