import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
    // Real `vscode` module is only injected at extension-host runtime;
    // for unit tests we stub it via a setupFile so any module that does
    // `import * as vscode from 'vscode'` (e.g. destCheck) loads cleanly.
    setupFiles: ['./test/setup/vscode-mock.ts']
  }
});
