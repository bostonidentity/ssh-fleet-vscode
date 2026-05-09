import { vi } from 'vitest';

/**
 * Minimal `vscode` module stub for vitest. Real `vscode` is only injected at
 * extension-host runtime; in unit tests we stub the surfaces the code under
 * test happens to import. Add more fields as new tests need them.
 */
vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
    showInputBox: vi.fn().mockResolvedValue(undefined),
    showQuickPick: vi.fn().mockResolvedValue(undefined),
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      append: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn()
    }))
  },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: vi.fn() })),
    fs: {}
  },
  commands: {
    executeCommand: vi.fn(),
    registerCommand: vi.fn(() => ({ dispose: vi.fn() }))
  },
  EventEmitter: class {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, path: p, toString: () => `file://${p}` }),
    joinPath: (base: { path: string }, ...parts: string[]) => ({
      fsPath: [base.path, ...parts].join('/'),
      path: [base.path, ...parts].join('/'),
      toString: () => 'file://' + [base.path, ...parts].join('/')
    }),
    from: (parts: { scheme: string; authority?: string; path?: string }) => ({
      scheme: parts.scheme,
      authority: parts.authority ?? '',
      path: parts.path ?? '',
      toString: () => `${parts.scheme}://${parts.authority ?? ''}${parts.path ?? ''}`
    })
  },
  ProgressLocation: { Notification: 15, SourceControl: 1, Window: 10 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  ThemeIcon: class {
    constructor(public id: string, public color?: unknown) {}
  },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  FileSystemError: {
    FileNotFound: (uri?: unknown) => new Error(`FileNotFound: ${String(uri)}`),
    NoPermissions: (uri?: unknown) => new Error(`NoPermissions: ${String(uri)}`),
    FileExists: (uri?: unknown) => new Error(`FileExists: ${String(uri)}`),
    Unavailable: (uri?: unknown) => new Error(`Unavailable: ${String(uri)}`)
  },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  Disposable: class {
    constructor(_fn?: () => void) {}
    dispose = vi.fn();
  }
}));
