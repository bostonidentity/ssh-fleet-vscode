import * as crypto from 'node:crypto';

/**
 * Compute the SHA-256 fingerprint of a host key, base64-encoded with the
 * trailing `=` padding stripped — matches the format `SHA256:<b64>` shown
 * by OpenSSH and `ssh-keygen -lf`.
 *
 * Pure function: extracted from the rest of the host-keys store so it's
 * unit-testable without a VSCode runtime.
 */
export function fingerprintSha256(keyBuf: Buffer): string {
  return crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}
