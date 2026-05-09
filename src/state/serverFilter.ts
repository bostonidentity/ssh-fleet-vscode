import * as vscode from 'vscode';
import type { ServerConfig } from '../config/types.js';
import { log } from '../util/logger.js';

const STATE_KEY = 'ssh-fleet.filter.v1';

interface PersistedFilter {
  text: string;
  envs: string[];
  mods: string[];
}

/** Stored as a map keyed by active-config name (e.g. "default.yml") so
 *  each config remembers its own filter independently. Switching configs
 *  swaps the in-memory filter to whatever was saved for the new one. */
type FilterMap = Record<string, PersistedFilter>;

/**
 * Active filter applied to the server list. Three orthogonal axes:
 * - text: substring against name/host/groups (case-insensitive)
 * - envs: a multi-select set of meta.environment values; empty = any
 * - modules: same shape against meta.module
 *
 * A server passes the filter when it matches all three axes.
 *
 * Persisted to globalState so the operator's filter survives a window
 * reload — re-typing `env=UAT` etc. on every restart was the most
 * common "why did my config disappear?" complaint.
 */
export class ServerFilterState implements vscode.Disposable {
  private text = '';
  private readonly envs = new Set<string>();
  private readonly mods = new Set<string>();

  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  /** Active config name (basename of the .yml file). Filter state is
   *  keyed by this so switching configs swaps in/out the saved filter
   *  for each. Falls back to a single shared bucket when undefined
   *  (no active config picked yet). */
  private activeConfigName: string | undefined;

  constructor(
    private readonly memento?: vscode.Memento,
    private readonly getActiveConfigName?: () => string | undefined
  ) {
    if (memento) {
      this.activeConfigName = getActiveConfigName?.();
      this.hydrateFromCurrentConfig();
    } else {
      log.info('Filter: constructed without memento — running in-memory only');
    }
  }

  /** Read the per-config filter map and load the entry matching the
   *  current active config. Migrates old single-record format on
   *  first encounter (treats it as belonging to the current config). */
  private hydrateFromCurrentConfig(): void {
    if (!this.memento) return;
    const raw = this.memento.get<unknown>(STATE_KEY);
    let map: FilterMap;
    if (raw && typeof raw === 'object' && 'text' in (raw as object)) {
      // Old single-record format — migrate by attributing it to the
      // current config (whatever that is). Best-effort: if no config
      // is active yet, store under '__default' so the data isn't lost.
      const r = raw as PersistedFilter;
      map = { [this.activeConfigName ?? '__default']: r };
      void this.memento.update(STATE_KEY, map);
      log.info(`Filter: migrated old single-record format to per-config map (under '${this.activeConfigName ?? '__default'}')`);
    } else {
      map = (raw as FilterMap) ?? {};
    }
    const key = this.activeConfigName ?? '__default';
    const saved = map[key];
    if (saved && typeof saved.text === 'string'
        && Array.isArray(saved.envs) && Array.isArray(saved.mods)) {
      this.text = saved.text;
      for (const v of saved.envs) this.envs.add(v);
      for (const v of saved.mods) this.mods.add(v);
      log.info(`Filter: hydrated for config '${key}' text="${this.text}" envs=[${[...this.envs].join(',')}] mods=[${[...this.mods].join(',')}]`);
    } else {
      log.info(`Filter: no saved state for config '${key}'`);
    }
  }

  /** Called by extension.ts when the active config changes. Saves the
   *  current state under the OLD config name, then loads state for the
   *  NEW config (or starts empty if it's first time on that config).
   *  Fires onDidChange so the UI re-renders. */
  onActiveConfigChanged(): void {
    if (!this.getActiveConfigName) return;
    const newName = this.getActiveConfigName();
    if (newName === this.activeConfigName) return;
    // Persist current state under the old name before switching.
    this.save();
    // Reset in-memory state.
    this.text = '';
    this.envs.clear();
    this.mods.clear();
    this.activeConfigName = newName;
    // Load saved state (if any) for the new config.
    this.hydrateFromCurrentConfig();
    this.emitter.fire();
  }

  private save(): void {
    if (!this.memento) return;
    const raw = this.memento.get<unknown>(STATE_KEY);
    const map: FilterMap = (raw && typeof raw === 'object' && !('text' in (raw as object)))
      ? { ...(raw as FilterMap) }
      : {};
    const key = this.activeConfigName ?? '__default';
    map[key] = {
      text: this.text,
      envs: [...this.envs],
      mods: [...this.mods]
    };
    void this.memento.update(STATE_KEY, map);
    log.info(`Filter: persisted for config '${key}' text="${this.text}" envs=[${[...this.envs].join(',')}] mods=[${[...this.mods].join(',')}]`);
  }

  private fireChanged(): void {
    this.save();
    this.emitter.fire();
  }

  get filterText(): string { return this.text; }
  get selectedEnvs(): string[] { return [...this.envs]; }
  get selectedModules(): string[] { return [...this.mods]; }

  isActive(): boolean {
    return this.text !== '' || this.envs.size > 0 || this.mods.size > 0;
  }

  setText(t: string): void {
    const next = t.trim();
    if (this.text !== next) {
      this.text = next;
      this.fireChanged();
    }
  }

  setEnvs(values: string[]): void {
    if (sameSet(this.envs, values)) return;
    this.envs.clear();
    for (const v of values) this.envs.add(v);
    this.fireChanged();
  }

  setModules(values: string[]): void {
    if (sameSet(this.mods, values)) return;
    this.mods.clear();
    for (const v of values) this.mods.add(v);
    this.fireChanged();
  }

  toggleEnv(v: string): void {
    if (this.envs.has(v)) this.envs.delete(v); else this.envs.add(v);
    this.fireChanged();
  }
  toggleModule(v: string): void {
    if (this.mods.has(v)) this.mods.delete(v); else this.mods.add(v);
    this.fireChanged();
  }

  clear(): void {
    if (!this.isActive()) return;
    this.text = '';
    this.envs.clear();
    this.mods.clear();
    this.fireChanged();
  }

  passes(s: ServerConfig): boolean {
    if (this.text) {
      const t = this.text.toLowerCase();
      const haystack = `${s.name} ${s.host} ${s.groups.join(' ')}`.toLowerCase();
      if (!haystack.includes(t)) return false;
    }
    if (this.envs.size > 0) {
      const v = s.meta?.environment ?? '';
      if (!this.envs.has(v)) return false;
    }
    if (this.mods.size > 0) {
      const v = s.meta?.module ?? '';
      if (!this.mods.has(v)) return false;
    }
    return true;
  }

  /** Distinct env values across the given config (sorted). */
  static availableEnvs(servers: readonly ServerConfig[]): string[] {
    const out = new Set<string>();
    for (const s of servers) {
      const v = s.meta?.environment;
      if (typeof v === 'string' && v) out.add(v);
    }
    return [...out].sort();
  }
  static availableModules(servers: readonly ServerConfig[]): string[] {
    const out = new Set<string>();
    for (const s of servers) {
      const v = s.meta?.module;
      if (typeof v === 'string' && v) out.add(v);
    }
    return [...out].sort();
  }

  summary(): string {
    const bits: string[] = [];
    if (this.envs.size > 0) bits.push(`env=${[...this.envs].join('/')}`);
    if (this.mods.size > 0) bits.push(`mod=${[...this.mods].join('/')}`);
    if (this.text) bits.push(`"${this.text}"`);
    return bits.join(' · ');
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function sameSet(set: Set<string>, arr: string[]): boolean {
  if (set.size !== arr.length) return false;
  for (const v of arr) if (!set.has(v)) return false;
  return true;
}
