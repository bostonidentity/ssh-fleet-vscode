/**
 * Compat layer: translate legacy YAML shapes (snake_case keys, flat auth
 * fields, shorthand server strings, plaintext passwords, etc.) into the
 * canonical internal form that the zod schema validates.
 *
 * Run `normalizeRawConfig(raw)` between YAML.parse and schema.parse.
 */

type Dict = Record<string, unknown>;

function isPlainObject(v: unknown): v is Dict {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pickFirst<T>(...values: (T | undefined | null)[]): T | undefined {
  for (const v of values) {
    if (v !== undefined && v !== null) {
      return v;
    }
  }
  return undefined;
}

function parseServerShorthand(s: string): {
  user?: string;
  host: string;
  port: number;
} {
  let port = 22;
  let user: string | undefined;
  let rest = s.trim();
  const at = rest.indexOf('@');
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  const colon = rest.lastIndexOf(':');
  if (colon >= 0) {
    const portStr = rest.slice(colon + 1);
    const parsed = Number(portStr);
    if (Number.isFinite(parsed) && parsed > 0) {
      port = parsed;
      rest = rest.slice(0, colon);
    }
  }
  return { user, host: rest, port };
}

function normalizeServer(input: unknown): Dict | undefined {
  if (typeof input === 'string') {
    const parsed = parseServerShorthand(input);
    return {
      name: parsed.host,
      host: parsed.host,
      port: parsed.port,
      user: parsed.user ?? defaultUser(),
      auth: { type: 'key' } // fall through to auto-detect at connect
    };
  }
  if (!isPlainObject(input)) {
    return undefined;
  }

  const s = input;
  const host = s.host as string | undefined;
  if (!host) {
    return undefined;
  }
  const name = (s.name as string | undefined) ?? host;
  const port = (s.port as number | undefined) ?? 22;
  const user = (s.user as string | undefined)
    ?? (s.username as string | undefined)
    ?? defaultUser();

  // Resolve auth: explicit `auth` block wins; otherwise fall back to
  // flat fields (key_file, password) and finally to "auto-detect key".
  let auth: Dict | undefined = isPlainObject(s.auth) ? { ...s.auth } : undefined;
  if (!auth) {
    if (typeof s.key_file === 'string' && s.key_file) {
      auth = { type: 'key', keyPath: s.key_file };
    } else if (typeof s.password === 'string' && s.password) {
      // Legacy `ENC(...)` placeholders (from a deprecated master-password
      // encryption scheme) are treated as opaque markers — we don't try to
      // decrypt them. Instead we route to a per-server passwordRef so the
      // user is prompted on first connect and the new password lands
      // cleanly in SecretStorage.
      auth = isLegacyEncryptedPlaceholder(s.password)
        ? { type: 'password', passwordRef: `${name}-password` }
        : { type: 'password', password: s.password };
    } else {
      auth = { type: 'key' }; // auto-detect at connect time
    }
  } else if ('password' in auth && isLegacyEncryptedPlaceholder(auth.password)) {
    // Same migration path when an explicit `auth` block has an ENC password.
    delete auth.password;
    auth.passwordRef = `${name}-password`;
  }

  // Pick up auth-related top-level fields when the user wrote them in
  // the legacy flat shape (`cachePassword: false` at server level next to
  // `password: ENC(...)`, no `auth:` block). Only applies to password
  // auth — copying onto key/agent auth would be meaningless. The explicit
  // `auth:` block path already preserves these via the `{...s.auth}`
  // spread above.
  if (auth.type === 'password' && typeof s.cachePassword === 'boolean'
      && !('cachePassword' in auth)) {
    auth.cachePassword = s.cachePassword;
  }

  // Preserve legacy descriptive fields under `meta` so they're queryable
  // but don't leak into our canonical type.
  const meta: Record<string, string> = {};
  for (const k of ['environment', 'module', 'last_password_update'] as const) {
    if (typeof s[k] === 'string' && s[k]) {
      meta[k] = s[k] as string;
    }
  }
  if (isPlainObject(s.meta)) {
    for (const [k, v] of Object.entries(s.meta)) {
      if (typeof v === 'string') {
        meta[k] = v;
      }
    }
  }

  const groups = Array.isArray(s.groups) ? s.groups : [];

  const result: Dict = { name, host, port, user, auth, groups };
  if (Object.keys(meta).length > 0) {
    result.meta = meta;
  }
  return result;
}

function defaultUser(): string {
  return process.env.USER ?? process.env.USERNAME ?? 'root';
}

/**
 * Recognise the legacy `ENC(...)` placeholder pattern from a deprecated
 * master-password encryption scheme. We don't decrypt these — we treat
 * them as opaque markers that mean "this password was once encrypted;
 * ask the user to re-enter so it lands in SecretStorage."
 */
function isLegacyEncryptedPlaceholder(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('ENC(') && v.endsWith(')');
}

function normalizeServers(input: unknown): unknown[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const out: unknown[] = [];
  for (const item of input) {
    const norm = normalizeServer(item);
    if (norm) {
      out.push(norm);
    }
  }
  return out;
}

function normalizeTask(input: unknown): Dict | undefined {
  if (!isPlainObject(input)) {
    return undefined;
  }
  const t = input;

  // Auto-detect type from src/dest shape — `command` is the default
  // when neither file path nor download/upload pair is present.
  let type = (t.type as string | undefined);
  if (!type) {
    if (typeof t.src === 'string' && typeof t.dest === 'string') {
      type = 'upload';
    } else if (typeof t.src === 'string') {
      type = 'script';
    } else {
      type = 'command';
    }
  }

  const out: Dict = {
    name: (t.name as string | undefined) ?? autoTaskName(type),
    type,
    timeout: (t.timeout as number | undefined) ?? 60,
    confirmBeforeRun: (t.confirmBeforeRun as boolean | undefined) ?? false
  };
  if (typeof t.command === 'string') {
    out.command = t.command;
  }
  if (typeof t.src === 'string') {
    out.src = t.src;
  }
  if (typeof t.dest === 'string') {
    out.dest = t.dest;
  }
  if (typeof t.mode === 'string' || typeof t.mode === 'number') {
    out.mode = String(t.mode);
  }
  if (typeof t.args === 'string') {
    out.args = t.args;
  }
  if (isPlainObject(t.env)) {
    out.env = t.env;
  }
  return out;
}

let taskAutoCounter = 0;
function autoTaskName(type: string): string {
  taskAutoCounter += 1;
  return `${type}-${taskAutoCounter}`;
}

function normalizeTasks(input: unknown): unknown[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const out: unknown[] = [];
  for (const item of input) {
    const norm = normalizeTask(item);
    if (norm) {
      out.push(norm);
    }
  }
  return out;
}

function normalizeSettings(input: unknown): Dict {
  if (!isPlainObject(input)) {
    return {};
  }
  // Pass-through default: any field the user wrote ends up in `out` and
  // then meets the schema, which is the single source of truth for what
  // settings are accepted. Only fields with explicit legacy snake_case
  // aliases get rewritten here. Whitelisting was the previous design and
  // it kept silently dropping new settings (preventSleep, archiveFormat,
  // shortenHostnames, …) every time the schema grew.
  const out: Dict = { ...input };

  const defaultTimeout = pickFirst(input.defaultTimeout, input.default_timeout);
  if (typeof defaultTimeout === 'number') {
    out.defaultTimeout = defaultTimeout;
    delete out.default_timeout;
  }
  const keepalive = pickFirst(input.keepaliveSeconds, input.keep_alive);
  if (typeof keepalive === 'number') {
    out.keepaliveSeconds = keepalive;
    delete out.keep_alive;
  }
  return out;
}

function normalizeWarnPattern(input: unknown): Dict | undefined {
  if (!isPlainObject(input)) {
    return undefined;
  }
  const p = input;
  if (typeof p.pattern !== 'string' || typeof p.label !== 'string' || typeof p.color !== 'string') {
    return undefined;
  }
  return { pattern: p.pattern, label: p.label, color: p.color };
}

function normalizeAutoBackup(input: unknown): Dict | undefined {
  if (!isPlainObject(input)) {
    return undefined;
  }
  const b = input;
  return {
    enabled: !!b.enabled,
    backupDir: pickFirst(b.backupDir, b.backup_dir) ?? '/opt/backup',
    commands: Array.isArray(b.commands) ? b.commands : ['rm', 'mv', 'cp', '>', 'sed']
  };
}

function normalizeDestCheck(input: unknown): Dict | undefined {
  if (!isPlainObject(input)) {
    return undefined;
  }
  const d = input;
  return {
    enabled: !!d.enabled,
    commands: Array.isArray(d.commands) ? d.commands.filter(c => typeof c === 'string') : ['cp', 'mv', '>']
  };
}

function normalizeSafety(input: unknown): Dict {
  if (!isPlainObject(input)) {
    return {};
  }
  const s = input;
  const patterns = pickFirst(s.serverWarnPatterns, s.server_warn_patterns);
  const autoBackup = pickFirst(s.autoBackup, s.auto_backup);
  const destCheck = pickFirst(s.destCheck, s.dest_check);

  const out: Dict = {};
  if (Array.isArray(patterns)) {
    const norm = patterns.map(normalizeWarnPattern).filter((p): p is Dict => p !== undefined);
    if (norm.length > 0) {
      out.serverWarnPatterns = norm;
    }
  }
  const ab = normalizeAutoBackup(autoBackup);
  if (ab) {
    out.autoBackup = ab;
  }
  const dc = normalizeDestCheck(destCheck);
  if (dc) {
    out.destCheck = dc;
  }
  return out;
}

function normalizeAliases(input: unknown): Record<string, string> {
  if (!isPlainObject(input)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}

function normalizeBookmarks(raw: Dict): string[] {
  if (Array.isArray(raw.bookmarks)) {
    return raw.bookmarks.filter((s): s is string => typeof s === 'string');
  }
  if (isPlainObject(raw.preferences) && Array.isArray((raw.preferences as Dict).bookmarks)) {
    return ((raw.preferences as Dict).bookmarks as unknown[])
      .filter((s): s is string => typeof s === 'string');
  }
  return [];
}

/**
 * Public entry point: takes the raw YAML object (already env-var-expanded by
 * the loader) and returns a fresh object shaped like the canonical AppConfig
 * input the zod schema expects.
 */
export function normalizeRawConfig(raw: unknown): Dict {
  if (!isPlainObject(raw)) {
    return {
      settings: {},
      servers: [],
      tasks: [],
      aliases: {},
      bookmarks: [],
      safety: {}
    };
  }
  const settings = normalizeSettings(raw.settings);
  const servers = normalizeServers(raw.servers);
  // Propagate `settings.cachePassword` down to every password-auth
  // server that hasn't set its own value, so the default applies before
  // the schema's per-server `default(true)` kicks in. The cascade is:
  // server.auth.cachePassword > settings.cachePassword > schema default
  // (true). Servers using key/agent auth are untouched.
  const configCachePassword = settings.cachePassword;
  if (typeof configCachePassword === 'boolean') {
    for (const s of servers) {
      if (isPlainObject(s) && isPlainObject((s as Dict).auth)) {
        const auth = (s as Dict).auth as Dict;
        if (auth.type === 'password' && !('cachePassword' in auth)) {
          auth.cachePassword = configCachePassword;
        }
      }
    }
  }
  return {
    settings,
    servers,
    tasks: normalizeTasks(raw.tasks),
    aliases: normalizeAliases(raw.aliases),
    bookmarks: normalizeBookmarks(raw),
    safety: normalizeSafety(raw.safety)
  };
}

/** Same logic but for standalone task files (bare list or {tasks: [...]}). */
export function normalizeTaskFile(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw
      .map(normalizeTask)
      .filter((t): t is Dict => t !== undefined);
  }
  if (isPlainObject(raw) && Array.isArray((raw as Dict).tasks)) {
    return ((raw as Dict).tasks as unknown[])
      .map(normalizeTask)
      .filter((t): t is Dict => t !== undefined);
  }
  return [];
}
