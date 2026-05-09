import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommandContext } from './context.js';

const SAMPLE_TASK = `# Standalone task file — drop YAMLs in this directory and they'll be
# auto-loaded into "SSH Fleet: Run Task…". Each file may use either form:
#
#   - name: ...
#     command: ...
#
# or wrapped:
#
#   tasks:
#     - name: ...
#       command: ...
#
# Tasks defined here merge into the active config's inline tasks; same-name
# tasks here override the inline ones (last wins).

- name: uptime
  command: uptime
  timeout: 10

- name: disk-usage
  command: df -h
  timeout: 15
`;

/**
 * Open the workspace's tasks/ folder. If it's empty, scaffold a starter file
 * so the user has something to edit; otherwise reveal it in the OS file
 * manager so they can manage their library.
 */
export async function cmdOpenTasksFolder(ctx: CommandContext): Promise<void> {
  const dir = ctx.workspace.tasksDir();
  if (!dir) {
    void vscode.window.showWarningMessage(
      'SSH Fleet: workspace not set. Run "Setup Workspace" first.'
    );
    return;
  }
  await fs.mkdir(dir, { recursive: true });

  const entries = await fs.readdir(dir);
  if (entries.length === 0) {
    const sample = path.join(dir, 'examples.yml');
    await fs.writeFile(sample, SAMPLE_TASK, 'utf-8');
    const doc = await vscode.workspace.openTextDocument(sample);
    await vscode.window.showTextDocument(doc);
    return;
  }
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
}

/**
 * Open the YAML file backing a task source group row for direct editing.
 * The tree item carries `resourceUri` set to the source file path; we
 * fall back to extracting it from the arg's `sourcePath` when invoked
 * programmatically (e.g. via context menu wiring that doesn't pass the
 * resource).
 */
export async function cmdOpenTaskFile(_ctx: CommandContext, arg: unknown): Promise<void> {
  let target: vscode.Uri | undefined;
  if (arg instanceof vscode.Uri) {
    target = arg;
  } else if (arg && typeof arg === 'object') {
    const a = arg as { resourceUri?: vscode.Uri; sourcePath?: string };
    if (a.resourceUri instanceof vscode.Uri) target = a.resourceUri;
    else if (typeof a.sourcePath === 'string') target = vscode.Uri.file(a.sourcePath);
  }
  if (!target) {
    void vscode.window.showWarningMessage('SSH Fleet: right-click a task source group to open its file.');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc);
}

/**
 * Prompt for a filename, scaffold a task file in `<workspace>/tasks/`,
 * tick it as active so the operator immediately sees its tasks in the
 * tree, and open it for editing.
 */
export async function cmdNewTaskFile(ctx: CommandContext): Promise<void> {
  const dir = ctx.workspace.tasksDir();
  if (!dir) {
    void vscode.window.showWarningMessage(
      'SSH Fleet: workspace not set. Run "Setup Workspace" first.'
    );
    return;
  }
  await fs.mkdir(dir, { recursive: true });

  const existing = new Set(
    (await fs.readdir(dir).catch(() => [] as string[]))
      .map(n => n.toLowerCase())
  );

  const raw = await vscode.window.showInputBox({
    title: 'New Task File',
    prompt: 'Filename for the new task YAML (without path).',
    placeHolder: 'my-tasks.yml',
    validateInput: input => {
      const v = input.trim();
      if (!v) return 'Filename is required.';
      if (/[\\/]/.test(v)) return 'No path separators — file lands in tasks/ directly.';
      const withExt = /\.ya?ml$/i.test(v) ? v : v + '.yml';
      if (existing.has(withExt.toLowerCase())) return `${withExt} already exists.`;
      return null;
    }
  });
  if (!raw) return;

  const fileName = /\.ya?ml$/i.test(raw.trim()) ? raw.trim() : raw.trim() + '.yml';
  const target = path.join(dir, fileName);
  await fs.writeFile(target, SAMPLE_TASK, 'utf-8');

  // Auto-tick: matches the operator's intent (they wouldn't be creating a
  // task file they don't want loaded). Skips a follow-up "now go tick the
  // box" step.
  const cur = new Set(ctx.prefs.selectedTaskFiles);
  cur.add(fileName);
  await ctx.prefs.setSelectedTaskFiles([...cur]);
  await ctx.config.reload();

  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc);
}
