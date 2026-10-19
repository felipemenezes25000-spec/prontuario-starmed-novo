import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * RFC 4648 Base32 (no padding) and RFC 4226 HOTP / RFC 6238 TOTP.
 * Used for authenticator-app MFA. SHA-1 is kept because that is what
 * standard authenticator apps implement for TOTP (RFC 6238 test vectors).
 */
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += B32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Caractere base32 inválido');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP with dynamic truncation. */
export function hotp(key: Buffer, counter: bigint, digits = 6): string {
  if (digits < 6 || digits > 8) throw new Error('digits deve estar entre 6 e 8');
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** RFC 6238 TOTP for a given timestamp in milliseconds. */
export function totpAt(key: Buffer, timestampMs: number, digits = 6, periodSec = 30): string {
  if (!Number.isFinite(timestampMs) || timestampMs < 0) throw new Error('timestamp inválido');
  const counter = BigInt(Math.floor(timestampMs / 1000 / periodSec));
  return hotp(key, counter, digits);
}

/**
 * Verifies a TOTP code with a symmetric window (default ±1 period) using
 * constant-time comparison. Rejects anything that is not exactly `digits` digits.
 */
export function verifyTotp(
  key: Buffer,
  code: string,
  timestampMs: number,
  window = 1,
  digits = 6,
  periodSec = 30
): boolean {
  const normalized = code.replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return false;
  const expected = Buffer.from(normalized, 'ascii');
  let ok = false;
  for (let offset = -window; offset <= window; offset++) {
    const candidate = Buffer.from(totpAt(key, timestampMs + offset * periodSec * 1000, digits, periodSec), 'ascii');
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) ok = true;
  }
  return ok;
}

export function generateTotpSecret(): { secretBase32: string; key: Buffer } {
  // 20 bytes = 160 bits, the RFC 4226 recommended secret size.
  const key = Buffer.from(
    Array.from({ length: 20 }, () => randomInt(256))
  );
  return { secretBase32: base32Encode(key), key };
}

export function buildOtpauthUri(params: {
  account: string;
  issuer: string;
  secretBase32: string;
  digits?: number;
  periodSec?: number;
}): string {
  const digits = params.digits ?? 6;
  const period = params.periodSec ?? 30;
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(period)
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/** Recovery codes: 10 codes, XXXXX-XXXXX, unambiguous alphabet (no I/L/O/0/1). */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateRecoveryCodes(count = 10): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    const chars = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]);
    codes.add(chars.slice(0, 5).join('') + '-' + chars.slice(5).join(''));
  }
  return [...codes];
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function recoveryCodeHash(code: string): string {
  return createHash('sha256')
    .update('starmed:recovery:' + normalizeRecoveryCode(code))
    .digest('hex');
}
