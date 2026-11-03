import crypto from 'crypto';

// Encrypts a secret before it is stored in the database — the Razorpay key
// secret and webhook secret entered in the Super Admin panel. AES-256-GCM, so
// a tampered value fails to decrypt rather than decrypting to garbage.
//
// The key is derived from SETTINGS_ENCRYPTION_KEY if set, else JWT_SECRET. A
// database dump on its own therefore does not reveal the secrets. If that
// server secret changes, stored secrets can no longer be read: the panel then
// shows them as missing and they are simply entered again.

const key = () =>
  crypto
    .createHash('sha256')
    .update(`trackowl-settings:${process.env.SETTINGS_ENCRYPTION_KEY || process.env.JWT_SECRET || 'secret'}`)
    .digest();

export const encryptSecret = (plain) => {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
};

// Returns '' when there is nothing stored or it cannot be decrypted.
export const decryptSecret = (stored) => {
  if (!stored) return '';
  try {
    const [version, iv, tag, data] = String(stored).split(':');
    if (version !== 'v1') return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
};

// "rzp_live_abcd…wxyz" style hint for showing that a secret is set.
export const maskSecret = (plain) => (plain ? `••••••••${String(plain).slice(-4)}` : '');
