import { describe, it, expect } from 'vitest';
import { aliasInitScript } from '../../src/features/aliases.js';

describe('aliasInitScript', () => {
  it('returns empty string for no aliases', () => {
    expect(aliasInitScript({})).toBe('');
  });

  it('renders a single alias', () => {
    expect(aliasInitScript({ ll: 'ls -ltrah' })).toBe("alias ll='ls -ltrah'");
  });

  it('joins multiple aliases with "; "', () => {
    const r = aliasInitScript({ ll: 'ls -ltrah', ports: 'ss -tulpn' });
    expect(r).toContain("alias ll='ls -ltrah'");
    expect(r).toContain("alias ports='ss -tulpn'");
    expect(r).toContain('; ');
  });

  it('escapes single quotes inside values (POSIX-safe)', () => {
    const r = aliasInitScript({ greet: "echo it's working" });
    // POSIX trick: end quote → escaped quote → reopen quote: '...'\''...'
    expect(r).toBe(`alias greet='echo it'\\''s working'`);
  });

  it("does not escape shell metacharacters that are safe inside single quotes", () => {
    // $ & ; | < > are all literal inside single quotes — no escaping needed.
    const r = aliasInitScript({ envcheck: 'echo $HOME && pwd; ls | head' });
    expect(r).toBe(`alias envcheck='echo $HOME && pwd; ls | head'`);
  });
});
