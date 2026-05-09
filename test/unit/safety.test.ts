import { describe, it, expect } from 'vitest';
import { detectInteractive, detectModifying, globMatch } from '../../src/features/safety.js';

describe('detectInteractive', () => {
  it.each([
    ['vim /etc/hosts', 'vim'],
    ['nano file.txt', 'nano'],
    ['top', 'top'],
    ['htop', 'htop'],
    ['less /var/log/syslog', 'less'],
    ['man bash', 'man'],
    ['/usr/bin/vim foo', 'vim'],
    ['ssh another-host', 'ssh'],
    ['tmux a', 'tmux']
  ])('flags %s as interactive', (cmd, expected) => {
    expect(detectInteractive(cmd)).toBe(expected);
  });

  it.each([
    'tail -f /var/log/syslog',
    'tail -100f log',
    'watch -n 5 ls',
    'ping example.com'
  ])('flags pattern %s as interactive', cmd => {
    expect(detectInteractive(cmd)).toBeDefined();
  });

  it.each([
    'ls -la',
    'cat /etc/hosts',
    'echo hello',
    'ps aux',
    'ping -c 3 example.com',  // -c bounds it
    '',
    '   '
  ])('does not flag %s as interactive', cmd => {
    expect(detectInteractive(cmd)).toBeUndefined();
  });

  it('detects interactive sub-commands in pipe chains', () => {
    expect(detectInteractive('ls | vim -')).toBe('vim');
    expect(detectInteractive('cat foo && top')).toBe('top');
    expect(detectInteractive('foo; less')).toBe('less');
  });
});

describe('detectModifying', () => {
  it.each([
    'rm /tmp/foo',
    'rm -rf /tmp/foo',
    'mv a b',
    'cp src dst',
    'sed -i s/a/b/ file',
    'chmod 755 file',
    'chown root file',
    'kill 123',
    'pkill nginx',
    'reboot',
    'apt install foo',
    'pip install foo',
    'iptables -F'
  ])('flags %s as modifying', cmd => {
    expect(detectModifying(cmd)).toBe(true);
  });

  it.each([
    'sudo rm -rf /tmp/x',
    'sudo systemctl restart nginx',
    'sudo apt update'
  ])('flags %s (sudo prefix) as modifying', cmd => {
    expect(detectModifying(cmd)).toBe(true);
  });

  it.each([
    'systemctl restart nginx',
    'systemctl stop foo',
    'service nginx restart',
    'mkdir /tmp/new',
    'echo hello | tee /etc/foo',
    'echo > /tmp/file',    // overwrite redirect
    'echo hi >> /var/log/app'  // append redirect — also modifies the file
  ])('flags pattern %s as modifying', cmd => {
    expect(detectModifying(cmd)).toBe(true);
  });

  it.each([
    'ls',
    'cat foo',
    'echo hi',
    'ps aux',
    'find / -name foo',
    '',
    '   '
  ])('does not flag %s as modifying', cmd => {
    expect(detectModifying(cmd)).toBe(false);
  });
});

describe('globMatch', () => {
  it.each([
    ['*prod*', 'web-prod-01', true],
    ['*prod*', 'prod', true],
    ['*prod*', 'prod-db', true],
    ['*prod*', 'staging-01', false],
    ['prod', 'prod', true],
    ['prod', 'prod-01', false],
    ['p?od', 'prod', true],
    ['p?od', 'paod', true],
    ['p?od', 'prood', false],
    ['*.example.com', 'web.example.com', true],
    ['*.example.com', 'example.com', false]
  ])('%s vs %s -> %s', (pattern, value, expected) => {
    expect(globMatch(pattern, value)).toBe(expected);
  });

  it('escapes regex metacharacters in pattern', () => {
    expect(globMatch('a+b', 'a+b')).toBe(true);
    expect(globMatch('a+b', 'aab')).toBe(false);
    expect(globMatch('a.b', 'aXb')).toBe(false);
  });
});
