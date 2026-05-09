import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as YAML from 'yaml';
import type { ConfigStore } from '../config/loader.js';
import type { TaskConfig } from '../config/types.js';
import type { CommandContext } from './context.js';

/** Stable identity for matching an in-memory task to a YAML item. We can't
 *  always rely on the `name:` field because tasks defined without one get
 *  an auto-generated in-memory name (`command-N`, etc.) that doesn't exist
 *  in the YAML. So when the in-memory name looks auto-generated, fall
 *  back to structural matching by `type` + content fields. */
export interface TaskIdentity {
  /** The in-memory task name (may be auto-generated). */
  name: string;
  type: 'command' | 'upload' | 'script';
  command?: string;
  src?: string;
  dest?: string;
  args?: string;
}

const AUTO_NAME_RE = /^(command|upload|script)-\d+$/;

/** Build an identity record from a TaskConfig. Used at drag time so the
 *  drop handler can find the YAML item even if it has no `name:` field. */
export function taskIdentity(t: TaskConfig): TaskIdentity {
  const id: TaskIdentity = { name: t.name, type: t.type };
  if (t.command !== undefined) id.command = t.command;
  if (t.src !== undefined) id.src = t.src;
  if (t.dest !== undefined) id.dest = t.dest;
  if (t.args !== undefined) id.args = t.args;
  return id;
}

/**
 * Move the targeted task up/down within whichever file it was defined in
 * (the active config's `tasks:` block OR a standalone `tasks/*.yml`).
 *
 * The arg comes from the right-click menu context — usually a TaskNode
 * carrying the full TaskConfig under `task`.
 */
export async function cmdTaskMoveUp(ctx: CommandContext, arg: unknown): Promise<void> {
  await moveTaskByDelta(ctx, extractTaskIdentity(arg), -1);
}

export async function cmdTaskMoveDown(ctx: CommandContext, arg: unknown): Promise<void> {
  await moveTaskByDelta(ctx, extractTaskIdentity(arg), 1);
}

function extractTaskIdentity(arg: unknown): TaskIdentity | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const a = arg as { task?: TaskConfig; kind?: string };
  if (a.task && typeof a.task === 'object' && a.task.name && a.task.type) {
    return taskIdentity(a.task);
  }
  return undefined;
}

async function moveTaskByDelta(
  ctx: CommandContext,
  id: TaskIdentity | undefined,
  delta: -1 | 1
): Promise<void> {
  if (!id) {
    void vscode.window.showWarningMessage('SSH Fleet: right-click a task in the Tasks view to reorder.');
    return;
  }
  const sourcePath = ctx.config.taskSources[id.name];
  if (!sourcePath) {
    void vscode.window.showWarningMessage(`SSH Fleet: can't locate the source file for "${id.name}".`);
    return;
  }
  await mutateTaskFile(sourcePath, items => {
    const idx = findItemIndex(items, id);
    if (idx < 0) return false;
    const target = idx + delta;
    if (target < 0 || target >= items.length) return false;
    const [moved] = items.splice(idx, 1);
    items.splice(target, 0, moved);
    return true;
  });
  await ctx.config.reload();
}

/**
 * Where to drop the moved tasks, relative to existing items in the file.
 *
 * - `before-task`: drop on a sibling task; placement is **direction-aware**
 *   (drag DOWN → land after target, drag UP → land before target). Matches
 *   Finder-style semantics.
 * - `top`: drop on the source-file group header — prepend to the file.
 * - `bottom`: drop in the empty area below all rows — append to the file.
 */
export type DropPlacement =
  | { mode: 'before-task'; target: TaskIdentity }
  | { mode: 'top' }
  | { mode: 'bottom' };

/**
 * Reorder a batch of tasks within a single source file. Drag-and-drop
 * entry point. `moving` is the ordered set of task identities being
 * moved.
 *
 * Returns true on success, false if the file couldn't be updated.
 */
export async function reorderTasksWithinSource(
  config: ConfigStore,
  sourcePath: string,
  moving: TaskIdentity[],
  placement: DropPlacement
): Promise<boolean> {
  if (moving.length === 0) return false;
  const ok = await mutateTaskFile(sourcePath, items => {
    // Resolve each moving identity to a YAML item index. Filter out
    // identities that don't match anything (e.g. stale drag from before
    // a config reload). Keep the FILE order so multi-drag preserves
    // visual relative ordering.
    const movingEntries = moving
      .map(id => ({ id, idx: findItemIndex(items, id) }))
      .filter(e => e.idx >= 0)
      .map(e => ({ id: e.id, item: items[e.idx], idx: e.idx }))
      .sort((a, b) => a.idx - b.idx);
    if (movingEntries.length === 0) return false;

    // Drop on a task that's part of the moving set is a no-op (operator
    // dropped on something they're already dragging).
    if (placement.mode === 'before-task') {
      const targetIdx = findItemIndex(items, placement.target);
      if (targetIdx < 0) return false;
      if (movingEntries.some(e => e.idx === targetIdx)) return false;
    }

    const movingSet = new Set(movingEntries.map(e => e.item));
    const remaining = items.filter(item => !movingSet.has(item));

    let insertAt: number;
    if (placement.mode === 'top') {
      insertAt = 0;
    } else if (placement.mode === 'bottom') {
      insertAt = remaining.length;
    } else {
      const targetIdxInItems = findItemIndex(items, placement.target);
      if (targetIdxInItems < 0) return false;
      // Direction: was the operator dragging DOWN (target below first
      // moved item) or UP?
      const draggingDown = targetIdxInItems > movingEntries[0].idx;
      const targetItem = items[targetIdxInItems];
      const tIdxInRemaining = remaining.findIndex(it => it === targetItem);
      insertAt = draggingDown ? tIdxInRemaining + 1 : tIdxInRemaining;
    }

    items.length = 0;
    items.push(
      ...remaining.slice(0, insertAt),
      ...movingEntries.map(e => e.item),
      ...remaining.slice(insertAt)
    );
    return true;
  });
  if (ok) await config.reload();
  return ok;
}

/**
 * Find a YAML item that matches the given task identity. Strategy:
 *
 * 1. If the identity has an explicit (non-auto-generated) name, look up by
 *    `name:` field. This is the common case and unambiguous.
 * 2. Otherwise, structural match: same `type`-discriminating fields and
 *    NO name in the YAML (we don't want to match a named task to a
 *    nameless identity).
 *
 * Returns -1 if no match.
 */
function findItemIndex(items: unknown[], id: TaskIdentity): number {
  const isAuto = AUTO_NAME_RE.test(id.name);
  if (!isAuto) {
    const i = items.findIndex(item => taskNameOf(item) === id.name);
    if (i >= 0) return i;
    // Named identity didn't match by name — could happen if the file was
    // edited between drag start and drop. Fall through to structural.
  }
  return items.findIndex(item => {
    if (!YAML.isMap(item)) return false;
    // Auto-named identity → only match nameless YAML items. (A named
    // YAML item would have matched by name above; matching it again
    // structurally risks false positives.)
    if (isAuto && item.get('name')) return false;
    if (id.type === 'command') {
      return typeof item.get('command') === 'string' && item.get('command') === id.command;
    }
    if (id.type === 'upload') {
      return item.get('src') === id.src && item.get('dest') === id.dest;
    }
    if (id.type === 'script') {
      // Scripts have `src` and optionally `args`. `args` may be missing.
      if (item.get('src') !== id.src) return false;
      const yamlArgs = item.get('args');
      return (yamlArgs ?? undefined) === (id.args ?? undefined);
    }
    return false;
  });
}

/**
 * Open a task source file (active config OR `tasks/*.yml`), find the
 * `tasks:` array (wrapped or top-level), apply `mutate` to its items, and
 * write back preserving comments via `eemeli/yaml`'s round-trip.
 *
 * `mutate` returns `true` if it changed `items`; `false` short-circuits
 * the write (no-op moves don't dirty the file).
 */
async function mutateTaskFile(
  filePath: string,
  mutate: (items: unknown[]) => boolean
): Promise<boolean> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf-8');
  } catch (e) {
    void vscode.window.showWarningMessage(
      `SSH Fleet: couldn't read ${path.basename(filePath)}: ${(e as Error).message}`
    );
    return false;
  }
  const doc = YAML.parseDocument(text);
  // Two valid shapes: top-level array (bare `- name:` form used by
  // standalone task files) OR a `tasks:` key under a map (the active
  // config form, also a permitted form for standalone files).
  let seq: YAML.YAMLSeq | undefined;
  if (YAML.isSeq(doc.contents)) {
    seq = doc.contents;
  } else if (YAML.isMap(doc.contents)) {
    const node = doc.get('tasks');
    if (YAML.isSeq(node)) seq = node;
  }
  if (!seq) {
    void vscode.window.showWarningMessage(
      `SSH Fleet: ${path.basename(filePath)} has no tasks array to reorder.`
    );
    return false;
  }
  const items = seq.items;
  const changed = mutate(items as unknown[]);
  if (!changed) return false;
  await fs.writeFile(filePath, doc.toString({ lineWidth: 0 }), 'utf-8');
  return true;
}

/** Read the `name` field from a YAML map item (or a bare string). */
function taskNameOf(item: unknown): string | undefined {
  if (YAML.isScalar(item) && typeof item.value === 'string') return item.value;
  if (YAML.isMap(item)) {
    const n = item.get('name');
    if (typeof n === 'string') return n;
  }
  return undefined;
}
