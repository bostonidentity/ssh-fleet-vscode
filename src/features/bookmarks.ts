import * as vscode from 'vscode';

const STATE_KEY = 'ssh-fleet.bookmarks.user.v1';

/**
 * Bookmark store — merges per-user (globalState) bookmarks with the
 * config-file bookmarks. Config bookmarks come first; user-added ones follow.
 */
export class BookmarkStore {
  constructor(private readonly state: vscode.Memento) {}

  list(configBookmarks: readonly string[]): string[] {
    const user = this.state.get<string[]>(STATE_KEY) ?? [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const b of [...configBookmarks, ...user]) {
      if (!seen.has(b)) {
        seen.add(b);
        out.push(b);
      }
    }
    return out;
  }

  async add(path: string): Promise<void> {
    const trimmed = path.trim();
    if (!trimmed) {
      return;
    }
    const user = this.state.get<string[]>(STATE_KEY) ?? [];
    if (user.includes(trimmed)) {
      return;
    }
    await this.state.update(STATE_KEY, [...user, trimmed]);
  }

  async remove(path: string): Promise<void> {
    const user = this.state.get<string[]>(STATE_KEY) ?? [];
    await this.state.update(STATE_KEY, user.filter(p => p !== path));
  }
}
