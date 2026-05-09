import { describe, it, expect } from 'vitest';
import { normalizeRawConfig, normalizeTaskFile } from '../../src/config/compat.js';

describe('normalizeRawConfig — empty / invalid', () => {
  it('produces empty canonical shape from null/undefined', () => {
    const r = normalizeRawConfig(null);
    expect(r).toEqual({ settings: {}, servers: [], tasks: [], aliases: {}, bookmarks: [], safety: {} });
  });

  it('produces empty canonical shape from non-object', () => {
    const r = normalizeRawConfig('garbage');
    expect(r.servers).toEqual([]);
  });
});

describe('normalizeRawConfig — settings', () => {
  it('maps snake_case keep_alive → keepaliveSeconds', () => {
    const r = normalizeRawConfig({ settings: { keep_alive: 45 } });
    expect((r.settings as Record<string, unknown>).keepaliveSeconds).toBe(45);
  });

  it('maps snake_case default_timeout → defaultTimeout', () => {
    const r = normalizeRawConfig({ settings: { default_timeout: 120 } });
    expect((r.settings as Record<string, unknown>).defaultTimeout).toBe(120);
  });

  it('camelCase passes through unchanged', () => {
    const r = normalizeRawConfig({ settings: { keepaliveSeconds: 30, defaultTimeout: 60 } });
    expect((r.settings as Record<string, unknown>).keepaliveSeconds).toBe(30);
    expect((r.settings as Record<string, unknown>).defaultTimeout).toBe(60);
  });

  // The compat layer used to whitelist a fixed set of fields and
  // silently drop anything else, which meant every new setting added to
  // the schema (preventSleep, archiveFormat, shortenHostnames, …) was
  // invisible until someone remembered to also patch the whitelist. The
  // schema is the source of truth now; compat only renames legacy keys.
  it('passes through schema-known fields not on the legacy alias list', () => {
    const r = normalizeRawConfig({
      settings: {
        preventSleep: true,
        archiveFormat: 'zip',
        archiveMinDepth: 3,
        shortenHostnames: false
      }
    });
    const s = r.settings as Record<string, unknown>;
    expect(s.preventSleep).toBe(true);
    expect(s.archiveFormat).toBe('zip');
    expect(s.archiveMinDepth).toBe(3);
    expect(s.shortenHostnames).toBe(false);
  });
});

describe('normalizeRawConfig — server shorthand', () => {
  it('parses "user@host" shorthand', () => {
    const r = normalizeRawConfig({ servers: ['deploy@web-01'] });
    const s = (r.servers as Array<Record<string, unknown>>)[0];
    expect(s.user).toBe('deploy');
    expect(s.host).toBe('web-01');
    expect(s.port).toBe(22);
  });

  it('parses "user@host:port" shorthand', () => {
    const r = normalizeRawConfig({ servers: ['deploy@web-01:2222'] });
    const s = (r.servers as Array<Record<string, unknown>>)[0];
    expect(s.user).toBe('deploy');
    expect(s.host).toBe('web-01');
    expect(s.port).toBe(2222);
  });

  it('parses bare "host" shorthand', () => {
    const r = normalizeRawConfig({ servers: ['web-01'] });
    const s = (r.servers as Array<Record<string, unknown>>)[0];
    expect(s.host).toBe('web-01');
    expect(s.port).toBe(22);
  });
});

describe('normalizeRawConfig — server fields', () => {
  it('maps username → user', () => {
    const r = normalizeRawConfig({ servers: [{ host: 'h', username: 'alice' }] });
    const s = (r.servers as Array<Record<string, unknown>>)[0];
    expect(s.user).toBe('alice');
  });

  it('keeps user as-is when present', () => {
    const r = normalizeRawConfig({ servers: [{ host: 'h', user: 'bob', username: 'alice' }] });
    const s = (r.servers as Array<Record<string, unknown>>)[0];
    expect(s.user).toBe('bob');
  });

  it('maps flat key_file → auth.type=key,keyPath', () => {
    const r = normalizeRawConfig({ servers: [{ host: 'h', user: 'u', key_file: '~/.ssh/id_rsa' }] });
    const s = (r.servers as Array<Record<string, unknown>>)[0];
    expect(s.auth).toEqual({ type: 'key', keyPath: '~/.ssh/id_rsa' });
  });

  it('maps flat plaintext password → auth.type=password,password', () => {
    const r = normalizeRawConfig({ servers: [{ host: 'h', user: 'u', password: 's3cret' }] });
    const s = (r.servers as Array<Record<string, unknown>>)[0];
    expect(s.auth).toEqual({ type: 'password', password: 's3cret' });
  });

  it('falls back to auth.type=key (auto-detect at connect) when nothing specified', () => {
    const r = normalizeRawConfig({ servers: [{ host: 'h', user: 'u' }] });
    const s = (r.servers as Array<Record<string, unknown>>)[0];
    expect(s.auth).toEqual({ type: 'key' });
  });

  it('preserves explicit auth block over flat fields', () => {
    const r = normalizeRawConfig({
      servers: [{ host: 'h', user: 'u', password: 'plain', auth: { type: 'agent' } }]
    });
    const s = (r.servers as Array<Record<string, unknown>>)[0];
    expect((s.auth as Record<string, unknown>).type).toBe('agent');
  });

  it('converts legacy ENC(...) flat password to passwordRef (per-server)', () => {
    const r = normalizeRawConfig({
      servers: [{
        name: 'web-01',
        host: 'h',
        user: 'u',
        password: 'ENC(gAAAAABpuhYtbp5rG3LfrV52a2j==)'
      }]
    });
    const s = (r.servers as Array<Record<string, unknown>>)[0];
    expect(s.auth).toEqual({ type: 'password', passwordRef: 'web-01-password' });
    // critical: the encrypted blob must NOT leak into the canonical config
    expect(JSON.stringify(s)).not.toContain('ENC(');
  });

  it('converts ENC(...) inside an explicit auth block too', () => {
    const r = normalizeRawConfig({
      servers: [{
        name: 'db-01',
        host: 'h',
        user: 'u',
        auth: { type: 'password', password: 'ENC(somecipher==)' }
      }]
    });
    const s = (r.servers as Array<Record<string, unknown>>)[0];
    const auth = s.auth as Record<string, unknown>;
    expect(auth.type).toBe('password');
    expect(auth.passwordRef).toBe('db-01-password');
    expect(auth.password).toBeUndefined();
  });

  it('uses host as passwordRef prefix when name is omitted (defaults to host)', () => {
    const r = normalizeRawConfig({
      servers: [{ host: 'web-fallback', user: 'u', password: 'ENC(x==)' }]
    });
    const s = (r.servers as Array<Record<string, unknown>>)[0];
    expect((s.auth as Record<string, unknown>).passwordRef).toBe('web-fallback-password');
  });

  it('folds environment / module / last_password_update into meta', () => {
    const r = normalizeRawConfig({
      servers: [{ host: 'h', user: 'u', environment: 'prod', module: 'web', last_password_update: '2025-01' }]
    });
    const s = (r.servers as Array<Record<string, unknown>>)[0];
    expect(s.meta).toEqual({
      environment: 'prod',
      module: 'web',
      last_password_update: '2025-01'
    });
  });

  it('uses host as default name', () => {
    const r = normalizeRawConfig({ servers: [{ host: 'web-01.example.com', user: 'u' }] });
    const s = (r.servers as Array<Record<string, unknown>>)[0];
    expect(s.name).toBe('web-01.example.com');
  });

  it('preserves explicit name', () => {
    const r = normalizeRawConfig({ servers: [{ name: 'web', host: 'h', user: 'u' }] });
    const s = (r.servers as Array<Record<string, unknown>>)[0];
    expect(s.name).toBe('web');
  });
});

describe('normalizeRawConfig — tasks (auto-type-detection)', () => {
  it('detects upload (src + dest)', () => {
    const r = normalizeRawConfig({ tasks: [{ name: 't', src: '/a', dest: '/b' }] });
    expect((r.tasks as Array<Record<string, unknown>>)[0].type).toBe('upload');
  });

  it('detects script (src only, no dest)', () => {
    const r = normalizeRawConfig({ tasks: [{ name: 't', src: '/a.sh' }] });
    expect((r.tasks as Array<Record<string, unknown>>)[0].type).toBe('script');
  });

  it('defaults to command when no src', () => {
    const r = normalizeRawConfig({ tasks: [{ name: 't', command: 'uptime' }] });
    expect((r.tasks as Array<Record<string, unknown>>)[0].type).toBe('command');
  });

  it('preserves explicit type', () => {
    const r = normalizeRawConfig({ tasks: [{ name: 't', type: 'command', src: '/a' }] });
    expect((r.tasks as Array<Record<string, unknown>>)[0].type).toBe('command');
  });

  it('coerces mode number to string', () => {
    const r = normalizeRawConfig({ tasks: [{ name: 't', src: '/a', dest: '/b', mode: 755 }] });
    expect((r.tasks as Array<Record<string, unknown>>)[0].mode).toBe('755');
  });
});

describe('normalizeRawConfig — safety (snake_case → camelCase)', () => {
  it('maps server_warn_patterns → serverWarnPatterns', () => {
    const r = normalizeRawConfig({
      safety: {
        server_warn_patterns: [{ pattern: '*prod*', label: 'PROD', color: '#ff0000' }]
      }
    });
    const safety = r.safety as Record<string, unknown>;
    expect(Array.isArray(safety.serverWarnPatterns)).toBe(true);
    expect((safety.serverWarnPatterns as Array<Record<string, unknown>>)[0].label).toBe('PROD');
  });

  it('maps auto_backup with snake_case backup_dir', () => {
    const r = normalizeRawConfig({
      safety: { auto_backup: { enabled: true, backup_dir: '/var/backup', commands: ['rm'] } }
    });
    const safety = r.safety as Record<string, unknown>;
    const ab = safety.autoBackup as Record<string, unknown>;
    expect(ab.enabled).toBe(true);
    expect(ab.backupDir).toBe('/var/backup');
    expect(ab.commands).toEqual(['rm']);
  });

  it('maps dest_check', () => {
    const r = normalizeRawConfig({
      safety: { dest_check: { enabled: true, commands: ['cp', 'mv'] } }
    });
    const safety = r.safety as Record<string, unknown>;
    const dc = safety.destCheck as Record<string, unknown>;
    expect(dc.enabled).toBe(true);
    expect(dc.commands).toEqual(['cp', 'mv']);
  });
});

describe('normalizeRawConfig — bookmarks location', () => {
  it('reads top-level bookmarks', () => {
    const r = normalizeRawConfig({ bookmarks: ['/var/log'] });
    expect(r.bookmarks).toEqual(['/var/log']);
  });

  it('reads legacy preferences.bookmarks', () => {
    const r = normalizeRawConfig({ preferences: { bookmarks: ['/opt/app'] } });
    expect(r.bookmarks).toEqual(['/opt/app']);
  });

  it('top-level wins over preferences', () => {
    const r = normalizeRawConfig({
      bookmarks: ['/new'],
      preferences: { bookmarks: ['/old'] }
    });
    expect(r.bookmarks).toEqual(['/new']);
  });
});

describe('normalizeTaskFile', () => {
  it('accepts bare list form', () => {
    const r = normalizeTaskFile([{ name: 'a', command: 'uptime' }]);
    expect(r).toHaveLength(1);
    expect((r[0] as Record<string, unknown>).type).toBe('command');
  });

  it('accepts wrapped { tasks: [...] } form', () => {
    const r = normalizeTaskFile({ tasks: [{ name: 'a', command: 'uptime' }] });
    expect(r).toHaveLength(1);
    expect((r[0] as Record<string, unknown>).command).toBe('uptime');
  });

  it('returns empty for unrecognised shapes', () => {
    expect(normalizeTaskFile(null)).toEqual([]);
    expect(normalizeTaskFile('hi')).toEqual([]);
    expect(normalizeTaskFile({})).toEqual([]);
  });

  it('auto-detects task type in standalone files', () => {
    const r = normalizeTaskFile({
      tasks: [
        { name: 'u', src: './a', dest: '/tmp/a' },
        { name: 's', src: './run.sh' },
        { name: 'c', command: 'date' }
      ]
    });
    expect((r[0] as Record<string, unknown>).type).toBe('upload');
    expect((r[1] as Record<string, unknown>).type).toBe('script');
    expect((r[2] as Record<string, unknown>).type).toBe('command');
  });
});
