import * as vscode from 'vscode';

const KEY = 'ssh-fleet.history.v1';
const MAX_PER_SERVER = 200;

interface HistoryEntry {
  command: string;
  ts: number;
}

interface HistoryStore {
  [serverName: string]: HistoryEntry[];
}

export class CommandHistory {
  constructor(private readonly state: vscode.Memento) {}

  private readAll(): HistoryStore {
    return this.state.get<HistoryStore>(KEY) ?? {};
  }

  private async writeAll(store: HistoryStore): Promise<void> {
    await this.state.update(KEY, store);
  }

  list(serverName: string): HistoryEntry[] {
    return this.readAll()[serverName] ?? [];
  }

  /** Add a command, dedup against the most recent entry, cap to MAX_PER_SERVER. */
  async record(serverName: string, command: string): Promise<void> {
    const cmd = command.trim();
    if (!cmd) {
      return;
    }
    const store = this.readAll();
    const list = store[serverName] ?? [];
    if (list[0]?.command === cmd) {
      return;
    }
    const updated = [{ command: cmd, ts: Date.now() }, ...list.filter(e => e.command !== cmd)];
    store[serverName] = updated.slice(0, MAX_PER_SERVER);
    await this.writeAll(store);
  }

  async clear(serverName: string): Promise<void> {
    const store = this.readAll();
    delete store[serverName];
    await this.writeAll(store);
  }
}
