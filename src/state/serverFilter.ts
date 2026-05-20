import * as vscode from 'vscode';
import type { ServerConfig } from '../config/types.js';
import { log } from '../util/logger.js';

const STATE_KEY = 'ssh-fleet.filter.v1';
const HISTORY_KEY = 'ssh-fleet.filter-history.v1';
const MAX_RECENT = 10;

interface PersistedFilter {
  text: string;
  envs: string[];
  mods: string[];
}

/** Stored as a map keyed by active-config name (e.g. "default.yml") so
 *  each config remembers its own filter independently. Switching configs
 *  swaps the in-memory filter to whatever was saved for the new one. */
type FilterMap = Record<string, PersistedFilter>;

/** A snapshot of env+module selections, captured automatically whenever
 *  the filter changes. `pinned` flips when the operator stars a recent
 *  entry — pinned entries survive the MAX_RECENT trim indefinitely. */
export interface HistoryEntry {
  envs: string[];
  mods: string[];
  ts: number;
  pinned?: boolean;
}

type HistoryMap = Record<string, HistoryEntry[]>;

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

  /** Per-config history of env+module combinations. Loaded once from
   *  memento, mutated in-place, persisted on every change. Pinned
   *  entries survive trim; unpinned trim down to MAX_RECENT by ts desc. */
  private historyByConfig: HistoryMap = {};

  constructor(
    private readonly memento?: vscode.Memento,
    private readonly getActiveConfigName?: () => string | undefined
  ) {
    if (memento) {
      this.activeConfigName = getActiveConfigName?.();
      this.hydrateFromCurrentConfig();
      this.hydrateHistory();
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
    this.captureToHistory();
    this.emitter.fire();
  }

  // ─── History ──────────────────────────────────────────────────────

  private hydrateHistory(): void {
    if (!this.memento) return;
    const raw = this.memento.get<unknown>(HISTORY_KEY);
    if (raw && typeof raw === 'object') {
      this.historyByConfig = raw as HistoryMap;
    }
  }

  private saveHistory(): void {
    if (!this.memento) return;
    void this.memento.update(HISTORY_KEY, this.historyByConfig);
  }

  private currentHistoryKey(): string {
    return this.activeConfigName ?? '__default';
  }

  private currentHistory(): HistoryEntry[] {
    const key = this.currentHistoryKey();
    if (!this.historyByConfig[key]) this.historyByConfig[key] = [];
    return this.historyByConfig[key];
  }

  /** Capture current env+mod selection into history. Requires at least
   *  one module — env-only combos are too ephemeral to be worth keeping
   *  (they're easy to re-pick from the Envs dropdown). Dedupes by
   *  value-equal envs+mods (updates ts in place rather than inserting). */
  private captureToHistory(): void {
    const envs = [...this.envs];
    const mods = [...this.mods];
    if (mods.length === 0) return;
    const entries = this.currentHistory();
    const idx = entries.findIndex(e => sameArr(e.envs, envs) && sameArr(e.mods, mods));
    if (idx >= 0) {
      entries[idx].ts = Date.now();
    } else {
      entries.push({ envs, mods, ts: Date.now() });
    }
    this.trimHistory();
    this.saveHistory();
  }

  /** Keep all pinned entries; trim non-pinned down to MAX_RECENT by ts desc. */
  private trimHistory(): void {
    const key = this.currentHistoryKey();
    const all = this.historyByConfig[key] ?? [];
    const pinned = all.filter(e => e.pinned);
    const nonPinned = all
      .filter(e => !e.pinned)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, MAX_RECENT);
    this.historyByConfig[key] = [...pinned, ...nonPinned];
  }

  /** Snapshot of the history for the current config (caller may sort
   *  freely). Returns a copy so mutations don't leak into our state. */
  getHistory(): HistoryEntry[] {
    return this.currentHistory().map(e => ({ ...e }));
  }

  /** Apply the env+mod selections from a history entry. Does NOT
   *  touch text — user-typed text survives a history apply (intentional;
   *  history is env+mod scoped, text is its own axis). */
  applyHistoryEntry(envs: string[], mods: string[]): void {
    if (sameSet(this.envs, envs) && sameSet(this.mods, mods)) return;
    this.envs.clear();
    for (const v of envs) this.envs.add(v);
    this.mods.clear();
    for (const v of mods) this.mods.add(v);
    this.fireChanged();
  }

  /** Flip pinned flag on the history entry matching the given envs+mods.
   *  No-op if no such entry exists. */
  togglePin(envs: string[], mods: string[]): void {
    const entries = this.currentHistory();
    const idx = entries.findIndex(e => sameArr(e.envs, envs) && sameArr(e.mods, mods));
    if (idx < 0) return;
    entries[idx].pinned = !entries[idx].pinned;
    entries[idx].ts = Date.now();
    this.trimHistory();
    this.saveHistory();
    this.emitter.fire();
  }

  /** Remove all unpinned entries from the current config's history. */
  clearRecent(): void {
    const key = this.currentHistoryKey();
    const all = this.historyByConfig[key] ?? [];
    this.historyByConfig[key] = all.filter(e => e.pinned);
    this.saveHistory();
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

/** Order-independent string-array equality (used to dedup history
 *  entries — Set→Array preserves insertion order, so two semantically
 *  equal selections may have different array order). */
function sameArr(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const aSorted = [...a].sort();
  const bSorted = [...b].sort();
  for (let i = 0; i < aSorted.length; i++) {
    if (aSorted[i] !== bSorted[i]) return false;
  }
  return true;
}
