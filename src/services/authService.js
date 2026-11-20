import crypto from 'crypto';

/**
 * PBKDF2 Password Hashing
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, key] = storedHash.split(':');
  if (!salt || !key) return false;
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return key === hash;
}

/**
 * Lightweight secure token generation for session verification
 */
export function generateToken(user) {
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role,
    staff_id: user.staff_id || null,
    issuedAt: Date.now()
  };
  const jsonStr = JSON.stringify(payload);
  const base64 = Buffer.from(jsonStr).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.JWT_SECRET || 'smartslot-secret-key-2026')
    .update(base64)
    .digest('base64url');
  return `${base64}.${signature}`;
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [base64, signature] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', process.env.JWT_SECRET || 'smartslot-secret-key-2026')
    .update(base64)
    .digest('base64url');
  if (signature !== expectedSig) return null;
  try {
    const jsonStr = Buffer.from(base64, 'base64url').toString('utf8');
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}
