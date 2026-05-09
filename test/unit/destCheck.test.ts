import { describe, it, expect } from 'vitest';
import { extractDestPath } from '../../src/features/destCheck.js';
import type { DestCheckConfig } from '../../src/config/types.js';

const ENABLED: DestCheckConfig = {
  enabled: true,
  commands: ['cp', 'mv', '>', 'tee', 'install', 'upload']
};
const DISABLED: DestCheckConfig = { ...ENABLED, enabled: false };

describe('extractDestPath — passthrough cases', () => {
  it('returns undefined when destCheck is disabled', () => {
    expect(extractDestPath('cp src /dst/file', DISABLED)).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(extractDestPath('', ENABLED)).toBeUndefined();
  });

  it('returns undefined when target is /dev/null', () => {
    expect(extractDestPath('echo hi > /dev/null', ENABLED)).toBeUndefined();
  });

  it('returns undefined for non-extracted commands (ls, cat, …)', () => {
    expect(extractDestPath('ls -la', ENABLED)).toBeUndefined();
    expect(extractDestPath('cat foo', ENABLED)).toBeUndefined();
    expect(extractDestPath('grep pattern /etc/passwd', ENABLED)).toBeUndefined();
  });

  it('returns undefined for relative dest (no leading /)', () => {
    expect(extractDestPath('cp src dst', ENABLED)).toBeUndefined();
    expect(extractDestPath('mv src ./dst', ENABLED)).toBeUndefined();
  });
});

describe('extractDestPath — cp / mv / install', () => {
  it('extracts dest from `cp src /dst`', () => {
    expect(extractDestPath('cp src /var/log/app.log', ENABLED))
      .toBe('/var/log/app.log');
  });

  it('extracts dest from `mv src /dst`', () => {
    expect(extractDestPath('mv src /etc/config.yml', ENABLED))
      .toBe('/etc/config.yml');
  });

  it('takes the last non-flag arg as dest (cp with multiple sources)', () => {
    expect(extractDestPath('cp a b c /dst/file', ENABLED))
      .toBe('/dst/file');
  });

  it('resolves single-source cp into dir/ → dir/basename(src)', () => {
    // `cp src dir/` = "copy file INTO dir", not "create file named 'dir'".
    // dest-check must verify the actual file `dir/basename(src)`, not the
    // dir itself (which is expected to exist as the container).
    expect(extractDestPath('cp src /opt/app/', ENABLED)).toBe('/opt/app/src');
    expect(extractDestPath('cp /home/admin/test.sh /home/admin/level1/level2/', ENABLED))
      .toBe('/home/admin/level1/level2/test.sh');
  });

  it('multi-source cp into dir/ skips dest-check (dir must exist)', () => {
    // `cp a b c dst/` requires dst to be an existing directory; dest-check
    // there would just whine "dir already exists". Skip it.
    expect(extractDestPath('cp a b c /dst/', ENABLED)).toBeUndefined();
  });

  it('handles install with mode flag', () => {
    expect(extractDestPath('install -m 0755 src /usr/local/bin/foo', ENABLED))
      .toBe('/usr/local/bin/foo');
  });

  it('preserves sudo prefix while extracting dest', () => {
    expect(extractDestPath('sudo cp src /etc/foo', ENABLED)).toBe('/etc/foo');
    // sudo + flag forms also stripped
    expect(extractDestPath('sudo -E cp src /etc/bar', ENABLED)).toBe('/etc/bar');
  });
});

describe('extractDestPath — > redirect', () => {
  it('extracts dest from `echo > /path`', () => {
    expect(extractDestPath('echo hi > /var/data/out', ENABLED))
      .toBe('/var/data/out');
  });

  it('extracts dest with `>` after sudo prefix', () => {
    expect(extractDestPath('sudo echo hi > /etc/foo.conf', ENABLED))
      .toBe('/etc/foo.conf');
  });

  it('returns undefined when > is not in cfg.commands', () => {
    const cfg: DestCheckConfig = { enabled: true, commands: ['cp'] };
    expect(extractDestPath('echo > /tmp/x', cfg)).toBeUndefined();
  });

  it('does NOT match `>>` (append) — only `>` overwrite', () => {
    expect(extractDestPath('echo line >> /var/log/app.log', ENABLED))
      .toBeUndefined();
  });
});

describe('extractDestPath — tee', () => {
  // Parser keys off `parts[0]` as the verb, so the command must START
  // with tee. Pipe-prefixed forms like `echo hi | tee /etc/foo` aren't
  // matched here — the `>` redirect path catches a redirect-style
  // overwrite, but `|` pipes don't have a generic "extract last arg"
  // analogue. Document the supported shape here.
  it('extracts dest from `tee /path` (overwrite mode, no pipe)', () => {
    expect(extractDestPath('tee /etc/foo', ENABLED)).toBe('/etc/foo');
  });

  it('returns undefined for `tee -a` (append mode is safe)', () => {
    expect(extractDestPath('tee -a /var/log/app.log', ENABLED))
      .toBeUndefined();
  });
});
