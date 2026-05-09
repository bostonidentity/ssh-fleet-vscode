import * as vscode from 'vscode';
import { log } from '../util/logger.js';

const STORAGE_KEY = 'ssh-fleet.schedule.v1';

export interface ScheduledTask {
  configName: string;
  serverNames: string[];
  command: string;
  intervalSec: number;
  enabled: boolean;
  /**
   * Silent mode — when true, ticks dispatch the command WITHOUT echoing
   * the run to the output area. Useful for "ping every 60s" loops that
   * would otherwise drown real output. Failures still surface.
   */
  silent?: boolean;
  /** Wall-clock millisecond of the most recent successful tick. */
  lastTickAt?: number;
}

/**
 * Periodic command runner per active config. Settings persist in globalState
 * so the same schedule resumes when the user reopens the editor; the actual
 * timer only runs while the extension is alive (no daemon).
 */
export class ScheduleStore implements vscode.Disposable {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly emitter = new vscode.EventEmitter<string>();
  /** Fires with the affected configName when its schedule changes. */
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  private load(): Record<string, ScheduledTask> {
    return this.state.get<Record<string, ScheduledTask>>(STORAGE_KEY) ?? {};
  }

  private async save(all: Record<string, ScheduledTask>): Promise<void> {
    await this.state.update(STORAGE_KEY, all);
  }

  get(configName: string): ScheduledTask | undefined {
    return this.load()[configName];
  }

  /** Re-arm timers for any persisted enabled schedule. Called once at activation. */
  resumeAll(tick: (task: ScheduledTask) => void): void {
    const all = this.load();
    for (const [name, task] of Object.entries(all)) {
      if (task.enabled) {
        this.armTimer(name, task, tick);
      }
    }
  }

  async start(
    configName: string,
    spec: Omit<ScheduledTask, 'configName' | 'enabled'>,
    tick: (task: ScheduledTask) => void | Promise<void>
  ): Promise<ScheduledTask> {
    const task: ScheduledTask = { ...spec, configName, enabled: true };
    const all = this.load();
    all[configName] = task;
    await this.save(all);
    this.armTimer(configName, task, tick);
    this.emitter.fire(configName);
    return task;
  }

  /** Stamp the most recent tick's wall-clock time so the UI can show
   *  "last ran 12s ago". Fires onDidChange so subscribers refresh. */
  async recordTick(configName: string): Promise<void> {
    const all = this.load();
    const t = all[configName];
    if (!t) return;
    t.lastTickAt = Date.now();
    await this.save(all);
    this.emitter.fire(configName);
  }

  async stop(configName: string): Promise<void> {
    const t = this.timers.get(configName);
    if (t) {
      clearInterval(t);
      this.timers.delete(configName);
    }
    const all = this.load();
    if (all[configName]) {
      all[configName].enabled = false;
      await this.save(all);
    }
    this.emitter.fire(configName);
  }

  private armTimer(
    configName: string,
    task: ScheduledTask,
    tick: (task: ScheduledTask) => void | Promise<void>
  ): void {
    const existing = this.timers.get(configName);
    if (existing) {
      clearInterval(existing);
    }
    if (task.intervalSec <= 0) {
      log.warn(`Schedule for ${configName} has non-positive interval; not arming`);
      return;
    }
    const handle = setInterval(() => {
      // Tick may be async — without awaiting and catching, an async failure
      // (network drop, runRemoteCommand reject) is silently dropped, leaving
      // the schedule looking healthy while every tick fails invisibly.
      void Promise.resolve()
        .then(() => tick(task))
        .catch(err => {
          log.error(`Scheduled tick failed for ${configName}`, err);
        });
    }, task.intervalSec * 1000);
    this.timers.set(configName, handle);
  }

  dispose(): void {
    for (const t of this.timers.values()) {
      clearInterval(t);
    }
    this.timers.clear();
    this.emitter.dispose();
  }
}
