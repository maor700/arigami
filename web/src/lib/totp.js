// VAULT1 — the one-time code of a vault entry that holds a TOTP secret (RFC 6238), computed in the vault worker so a
// "one-time code" field on the shared desktop is filled like a password: the host types it, nobody reads it.
// KeePassXC keeps it as an `otp` field holding an otpauth:// URI; KeePass 2.x as "TOTP Seed" (+ "TOTP Settings").

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(s) {
  const clean = String(s || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** The TOTP parameters an entry holds, or null. `fields` maps a field name to its text. */
export function totpSpec(fields) {
  const uri = fields.otp || fields.OTP || '';
  if (/^otpauth:\/\/totp\//i.test(uri)) {
    const u = new URL(uri);
    const secret = u.searchParams.get('secret');
    if (!secret) return null;
    return {
      secret,
      digits: Number(u.searchParams.get('digits')) || 6,
      period: Number(u.searchParams.get('period')) || 30,
      algorithm: (u.searchParams.get('algorithm') || 'SHA1').toUpperCase().replace(/^SHA-?/, 'SHA-'),
    };
  }
  const seed = fields['TOTP Seed'];
  if (seed) {
    // "TOTP Settings": "<period>;<digits>" (KeePass 2.x KeeOtp convention)
    const [p, d] = String(fields['TOTP Settings'] || '').split(';').map(Number);
    return { secret: seed, digits: d || 6, period: p || 30, algorithm: 'SHA-1' };
  }
  return null;
}

/** RFC 6238: the code at `atMs`. */
export async function totp(spec, atMs = Date.now()) {
  const key = await crypto.subtle.importKey('raw', base32Decode(spec.secret), { name: 'HMAC', hash: spec.algorithm === 'SHA1' ? 'SHA-1' : spec.algorithm }, false, ['sign']);
  const counter = Math.floor(atMs / 1000 / spec.period);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** spec.digits).padStart(spec.digits, '0');
}
