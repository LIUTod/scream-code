import { createHash, randomBytes } from 'node:crypto';

/** Encode bytes as a base64url string (RFC 4648 section 5, no padding). */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Generate a PKCE code verifier/challenge pair (RFC 7636, S256).
 * The verifier is 32 random bytes; the challenge is its SHA-256 digest.
 */
export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Random URL-safe token, used for OAuth `state` (CSRF binding). */
export function randomUrlSafe(byteLength = 32): string {
  return base64UrlEncode(randomBytes(byteLength));
}
