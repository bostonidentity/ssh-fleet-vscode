import { z } from 'zod';

const authKey = z.object({
  type: z.literal('key'),
  // keyPath is optional — when missing, connection time auto-detects ~/.ssh/id_rsa or id_ed25519.
  keyPath: z.string().min(1).optional(),
  passphraseRef: z.string().optional()
});

const authPassword = z.object({
  type: z.literal('password'),
  // passwordRef → looked up in SecretStorage; password → plaintext (legacy
  // compat). Both optional: when neither is set, connection.ts derives a
  // default ref `<name>-password` and prompts on first connect.
  passwordRef: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  // When false, the extension never reads from or writes to the OS
  // keychain for this server's credential — every connect prompts fresh.
  // Use this for servers where the "password" field is actually a
  // dynamic value (TOTP / RSA SecurID / Duo OTP / time-based code) — a
  // cached value would always be stale and auth would always fail.
  // Also appropriate for high-security servers where caching is
  // disallowed by policy. Defaults to true (cache enabled).
  cachePassword: z.boolean().default(true)
});

const authAgent = z.object({
  type: z.literal('agent')
});

// Plain union (not discriminatedUnion) because authPassword carries a refine,
// which zod doesn't allow inside discriminated unions.
export const authSchema = z.union([authKey, authPassword, authAgent]);

export const serverSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive().max(65535).default(22),
  user: z.string().min(1),
  auth: authSchema,
  groups: z.array(z.string()).default([]),
  meta: z.record(z.string(), z.string()).optional()
});

/**
 * Tasks come in three flavours:
 *  - command: run a shell command on the remote (default)
 *  - upload:  SFTP-write a local file to a remote path, with optional chmod
 *  - script:  upload a local script to a remote temp path, run it, then clean up
 */
export const taskSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['command', 'upload', 'script']).default('command'),
  command: z.string().optional(),
  src: z.string().optional(),
  dest: z.string().optional(),
  mode: z.string().optional(),
  args: z.string().optional(),
  timeout: z.number().nonnegative().default(60),
  env: z.record(z.string(), z.string()).optional(),
  confirmBeforeRun: z.boolean().default(false)
}).superRefine((task, ctx) => {
  if (task.type === 'command' && !task.command) {
    ctx.addIssue({ code: 'custom', message: `Task '${task.name}': command is required for command tasks` });
  }
  if (task.type === 'upload') {
    if (!task.src) ctx.addIssue({ code: 'custom', message: `Task '${task.name}': src is required for upload` });
    if (!task.dest) ctx.addIssue({ code: 'custom', message: `Task '${task.name}': dest is required for upload` });
  }
  if (task.type === 'script' && !task.src) {
    ctx.addIssue({ code: 'custom', message: `Task '${task.name}': src is required for script` });
  }
});

/** Standalone task-file shape: either a bare list or `{ tasks: [...] }`. */
export const taskFileSchema = z.union([
  z.array(taskSchema),
  z.object({ tasks: z.array(taskSchema) }).transform(o => o.tasks)
]);

export const warnPatternSchema = z.object({
  pattern: z.string().min(1),
  label: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/, 'expected hex color like #dc2626')
});

export const autoBackupSchema = z.object({
  enabled: z.boolean().default(false),
  backupDir: z.string().default('/opt/backup'),
  commands: z.array(z.string()).default(['rm', 'mv', 'cp', '>', 'sed'])
});

export const destCheckSchema = z.object({
  // Default ON: safety features should fail safe. An operator who knows
  // they want a no-questions-asked overwrite can set `enabled: false`.
  enabled: z.boolean().default(true),
  commands: z.array(z.string()).default(['cp', 'mv', '>', 'tee', 'install', 'upload'])
});

export const safetySchema = z.object({
  serverWarnPatterns: z.array(warnPatternSchema).default([]),
  autoBackup: autoBackupSchema.default({}),
  destCheck: destCheckSchema.default({})
});

export const settingsSchema = z.object({
  defaultTimeout: z.number().nonnegative().default(60),
  keepaliveSeconds: z.number().positive().default(30),
  /**
   * Listing command applied when clicking a directory in the breadcrumb /
   * output / bookmark dropdown. Webview sends `cd <target> && <lsCommand>`
   * so changing this here changes every "navigate-and-list" surface at once.
   */
  lsCommand: z.string().default('ls -ltr'),
  /**
   * Config-wide default for `auth.cachePassword`. Applies to every server
   * with `auth.type: password` that doesn't set its own value. Useful for
   * "the whole config is OTP-only" scenarios — set false here and every
   * server prompts every connect, no per-server override needed.
   */
  cachePassword: z.boolean().optional(),
  /**
   * Hard cap on how many servers a single action (broadcast, task, file
   * open / download, group select) can target. Prevents accidents like
   * a fat-finger Select-All on a 200-server fleet triggering 200 parallel
   * SSH handshakes. The TreeView refuses ticks past this cap; the
   * dispatch path re-checks defensively. Set 0 to disable the cap
   * entirely (your responsibility to know what you're doing). Default 20.
   */
  maxServersPerAction: z.number().int().nonnegative().default(20),
  /**
   * Soft warning threshold (MB) for opening a remote file in the editor.
   * Above this, click / `:se` / open-on-selected pops a modal asking
   * "open anyway?". Aligned with VSCode's own ~50 MB editor hard limit
   * — opening files larger than VSCode would render anyway is just SFTP
   * waste. Set 0 to skip the warning. Default 50.
   */
  maxFileOpenSize: z.number().nonnegative().default(50),
  /**
   * Hard cap (MB) on remote file size for click-to-open and `:dl`
   * downloads. Above this the action is refused — operator must use a
   * native tool (scp / rsync) or raise the cap in their config file.
   * Protects against accidental gigabyte downloads that would freeze
   * the editor / fill local disk. Set 0 to disable. Default 500.
   */
  maxFileDownloadSize: z.number().nonnegative().default(500),
  /**
   * Archive format used by "Download as archive…" (right-click a remote
   * directory). 'auto' = try zip first, fall back to tar.gz if `zip` is
   * not installed on the remote. 'zip' / 'tar.gz' force one format and
   * fail if it's missing. Default 'auto' is the best fit for mixed
   * environments where some Linux servers don't ship `zip`.
   */
  archiveFormat: z.enum(['auto', 'zip', 'tar.gz']).default('auto'),
  /**
   * Minimum directory depth allowed for "Download as archive…". Default 2
   * blocks accidental downloads of `/` or shallow first-level dirs like
   * `/etc`, `/var`, `/tmp` which routinely contain GB of unrelated data.
   * Lower to 1 to allow `/etc`-level dirs, or 0 to disable the guard.
   */
  archiveMinDepth: z.number().int().nonnegative().default(2),
  /**
   * Shorten long hostnames in output prefixes — `[aaa.bbb.example.com]`
   * displays as `[aaa]` to save horizontal space on lines that repeat
   * the prefix many times. Full hostname is preserved as a hover
   * tooltip on the prefix span. IP addresses and short names (no dot)
   * are never truncated. Default ON.
   */
  shortenHostnames: z.boolean().default(true),
  /**
   * Prevent the LOCAL workstation from sleeping while operating
   * SSH Fleet. Latches on the first sign of use in this window
   * (TreeView visible after activation grace, first server connect,
   * or Console panel open) and runs until the window closes or this
   * setting flips off — see `extension.ts` keepAwake gate.
   *
   * Implemented via a subprocess held alive by the extension:
   *   macOS   → `caffeinate -di`
   *   Linux   → `systemd-inhibit --what=idle:sleep ...`
   *   Windows → `python.exe resources/prevent_sleep.py` (sleep API
   *             + 1-px mouse nudge every 60s; needs python.exe on PATH)
   *
   * Default OFF — most operators don't need this and OS-level sleep
   * inhibitors can surprise them. Opt in via config.
   */
  preventSleep: z.boolean().default(false)
});

export const appConfigSchema = z.object({
  settings: settingsSchema.default({}),
  servers: z.array(serverSchema).default([]),
  tasks: z.array(taskSchema).default([]),
  aliases: z.record(z.string(), z.string()).default({}),
  bookmarks: z.array(z.string()).default([]),
  safety: safetySchema.default({})
});

export type AuthConfig = z.infer<typeof authSchema>;
export type ServerConfig = z.infer<typeof serverSchema>;
export type TaskConfig = z.infer<typeof taskSchema>;
export type WarnPattern = z.infer<typeof warnPatternSchema>;
export type AutoBackupConfig = z.infer<typeof autoBackupSchema>;
export type DestCheckConfig = z.infer<typeof destCheckSchema>;
export type SafetyConfig = z.infer<typeof safetySchema>;
export type SettingsConfig = z.infer<typeof settingsSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
