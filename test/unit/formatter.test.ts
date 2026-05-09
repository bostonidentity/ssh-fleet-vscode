import { describe, it, expect } from 'vitest';
import { clipLine, prefixLines, timestamp } from '../../src/output/formatter.js';

describe('clipLine', () => {
  it('passes short lines through unchanged', () => {
    const r = clipLine('hello world');
    expect(r.text).toBe('hello world');
    expect(r.clipped).toBe(false);
  });

  it('passes empty string through', () => {
    expect(clipLine('').text).toBe('');
    expect(clipLine('').clipped).toBe(false);
  });

  it('clips lines over 4KB and marks them', () => {
    const long = 'a'.repeat(5000);
    const r = clipLine(long);
    expect(r.clipped).toBe(true);
    expect(r.text).toContain('truncated');
    expect(r.text.length).toBeGreaterThan(4096);
  });

  it('handles multibyte unicode without crashing', () => {
    // Unicode chars (3 bytes each in UTF-8) approaching the limit
    const cn = '中'.repeat(2000);
    const r = clipLine(cn);
    // 2000 * 3 = 6000 bytes > 4096 → clipped
    expect(r.clipped).toBe(true);
  });
});

describe('prefixLines', () => {
  it('prefixes a single line with [server] timestamp │', () => {
    const out = prefixLines('web-01', 'hello\n', 'stdout');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^\[web-01\] \d{2}:\d{2}:\d{2} │ hello$/);
  });

  it('splits a multi-line chunk into separate lines', () => {
    const out = prefixLines('web-01', 'line1\nline2\nline3\n', 'stdout');
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('line1');
    expect(out[1]).toContain('line2');
    expect(out[2]).toContain('line3');
  });

  it('skips empty lines from trailing or doubled newlines', () => {
    const out = prefixLines('web-01', 'one\n\ntwo\n', 'stdout');
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('one');
    expect(out[1]).toContain('two');
  });

  it('strips trailing \\r (CRLF normalisation)', () => {
    const out = prefixLines('web-01', 'hello\r\n', 'stdout');
    expect(out[0]).toMatch(/hello$/);
    expect(out[0]).not.toContain('\r');
  });

  it('marks stderr chunks with " err" tag', () => {
    const out = prefixLines('web-01', 'oops\n', 'stderr');
    expect(out[0]).toMatch(/^\[web-01\] err \d{2}:\d{2}:\d{2} │ oops$/);
  });
});

describe('timestamp', () => {
  it('emits HH:MM:SS with zero-padding', () => {
    expect(timestamp()).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});
