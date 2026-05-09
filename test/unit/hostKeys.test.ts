import { describe, it, expect } from 'vitest';
import { fingerprintSha256 } from '../../src/ssh/fingerprint.js';

describe('fingerprintSha256', () => {
  it('matches known SHA-256 base64 (no padding) for a known input', () => {
    // SHA-256 of empty buffer in base64 (no '=' padding):
    //   $ printf '' | openssl dgst -sha256 -binary | base64
    //   47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=
    const fp = fingerprintSha256(Buffer.from(''));
    expect(fp).toBe('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU');
    expect(fp.endsWith('=')).toBe(false);
  });

  it('strips trailing "=" padding (matches OpenSSH ssh-keygen -lf format)', () => {
    // Any input — verify no "=" anywhere in the fingerprint. OpenSSH's
    // SHA256:<b64> format drops padding; we must match.
    for (const len of [1, 16, 32, 100, 256]) {
      const fp = fingerprintSha256(Buffer.alloc(len, 0xab));
      expect(fp).not.toContain('=');
    }
  });

  it('produces different fingerprints for different inputs', () => {
    const a = fingerprintSha256(Buffer.from('alpha'));
    const b = fingerprintSha256(Buffer.from('beta'));
    expect(a).not.toBe(b);
    expect(a.length).toBe(b.length); // both 43 chars (256 bits / 6 bits-per-b64-char, no padding)
  });
});
