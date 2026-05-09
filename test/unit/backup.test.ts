import { describe, it, expect } from 'vitest';
import { wrapBackup } from '../../src/features/backup.js';
import type { AutoBackupConfig } from '../../src/config/types.js';

const ENABLED: AutoBackupConfig = {
  enabled: true,
  backupDir: '/opt/backup',
  commands: ['rm', 'mv', 'cp', '>', 'sed']
};
const DISABLED: AutoBackupConfig = { enabled: false, backupDir: '/opt/backup', commands: [] };

describe('wrapBackup — passthrough cases', () => {
  it('returns original when disabled', () => {
    expect(wrapBackup('rm /tmp/foo', DISABLED)).toBe('rm /tmp/foo');
  });

  it('returns original on empty input', () => {
    expect(wrapBackup('', ENABLED)).toBe('');
    expect(wrapBackup('   ', ENABLED)).toBe('   ');
  });

  it('returns original for non-modifying commands', () => {
    expect(wrapBackup('ls -la', ENABLED)).toBe('ls -la');
    expect(wrapBackup('cat foo', ENABLED)).toBe('cat foo');
  });

  it('returns original when target is inside backup_dir', () => {
    expect(wrapBackup('rm /opt/backup/old.txt', ENABLED)).toBe('rm /opt/backup/old.txt');
    expect(wrapBackup('rm /opt/backup/sub/x', ENABLED)).toBe('rm /opt/backup/sub/x');
  });

  it('returns original when target is /dev/null', () => {
    expect(wrapBackup('echo > /dev/null', ENABLED)).toBe('echo > /dev/null');
  });
});

describe('wrapBackup — rm', () => {
  it('wraps rm <path> with cp -a backup', () => {
    const result = wrapBackup('rm /tmp/foo', ENABLED);
    expect(result).toContain('cp -a /tmp/foo');
    expect(result).toContain('mkdir -p /opt/backup');
    expect(result).toContain('rm /tmp/foo');
    expect(result).toContain("if ");
    expect(result).toContain('then');
    expect(result).toContain('exit 1');
  });

  it('handles multiple rm targets', () => {
    const result = wrapBackup('rm /tmp/a /tmp/b', ENABLED);
    expect(result).toContain('cp -a /tmp/a');
    expect(result).toContain('cp -a /tmp/b');
  });

  it('skips wildcard targets with a warning', () => {
    const result = wrapBackup('rm /tmp/*.log', ENABLED);
    expect(result).toContain('[WARN]');
    expect(result).toContain('wildcard');
    expect(result).toContain('rm /tmp/*.log');
  });

  it('preserves sudo prefix', () => {
    const result = wrapBackup('sudo rm /tmp/x', ENABLED);
    expect(result).toContain('sudo cp -a /tmp/x');
    expect(result).toContain('sudo mkdir -p');
  });
});

describe('wrapBackup — mv / cp', () => {
  it('mv backups source (first non-flag arg)', () => {
    const result = wrapBackup('mv /tmp/a /tmp/b', ENABLED);
    expect(result).toContain('cp -a /tmp/a');
    // /tmp/b is destination, not source — should not be backed up
    const cpaCount = (result.match(/cp -a/g) ?? []).length;
    expect(cpaCount).toBe(1);
  });

  it('cp backups destination (last non-flag arg)', () => {
    const result = wrapBackup('cp /src/a /src/b /dst/', ENABLED);
    expect(result).toContain('cp -a /dst/');
  });

  it('cp with single src+dst backs up dst', () => {
    const result = wrapBackup('cp /src/a /dst/file', ENABLED);
    expect(result).toContain('cp -a /dst/file');
  });
});

describe('wrapBackup — sed', () => {
  it('wraps sed -i with file backup', () => {
    const result = wrapBackup('sed -i s/a/b/ /etc/foo.conf', ENABLED);
    expect(result).toContain('cp -a /etc/foo.conf');
  });

  it('does not wrap sed without -i', () => {
    expect(wrapBackup('sed s/a/b/ /etc/foo.conf', ENABLED)).toBe('sed s/a/b/ /etc/foo.conf');
  });
});

describe('wrapBackup — redirect overwrite', () => {
  it('wraps echo > /etc/file', () => {
    const result = wrapBackup('echo hello > /etc/foo', ENABLED);
    expect(result).toContain('cp -a /etc/foo');
    expect(result).toContain('mkdir -p /opt/backup');
  });

  it('does not wrap >> append', () => {
    expect(wrapBackup('echo hi >> /var/log/app', ENABLED)).toBe('echo hi >> /var/log/app');
  });

  it('does not wrap stderr redirect 2>', () => {
    expect(wrapBackup('cmd 2>/tmp/err', ENABLED)).toBe('cmd 2>/tmp/err');
  });

  it('does not wrap fd redirect &>', () => {
    expect(wrapBackup('cmd &>/tmp/log', ENABLED)).toBe('cmd &>/tmp/log');
  });
});

describe('wrapBackup — cd && prefix', () => {
  it('preserves cd prefix in wrapped output', () => {
    const result = wrapBackup('cd /tmp && rm foo', ENABLED);
    expect(result.startsWith('cd /tmp &&')).toBe(true);
    expect(result).toContain('cp -a foo');
  });
});

describe('wrapBackup — selective commands', () => {
  it('does not wrap commands not in cfg.commands', () => {
    const cfg: AutoBackupConfig = { enabled: true, backupDir: '/opt/backup', commands: ['rm'] };
    expect(wrapBackup('mv a b', cfg)).toBe('mv a b'); // mv not in commands
    const wrapped = wrapBackup('rm a', cfg);
    expect(wrapped).toContain('cp -a a');
  });
});
