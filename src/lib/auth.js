import jwt from 'jsonwebtoken';
import { pool } from '../db/pool.js';

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.warn('WARNING: JWT_SECRET is not set — auth tokens will not be secure.');
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, roles: user.roles }, SECRET, { expiresIn: '30d' });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    req.user = jwt.verify(token, SECRET); // { sub, roles } — roles here are a snapshot from login/signup time
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// Cheap role check against the JWT's snapshot. Fine for roles that rarely
// change mid-session (e.g. 'spotter' is set at signup and never revoked).
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user?.roles?.includes(role)) {
      return res.status(403).json({ error: 'forbidden', needs_role: role });
    }
    next();
  };
}

// A role check that re-reads the database instead of trusting the JWT.
// Required for 'admin' and 'collector' specifically, because both can be
// granted or revoked mid-session (an admin approving a collector
// application, or banning an admin) — trusting a 30-day-old token for
// those would mean a revoked admin keeps admin access until their token
// expires. A few extra ms of DB latency on these routes is the right trade.
export function requireCurrentRole(role) {
  return async (req, res, next) => {
    if (!req.user?.sub) return res.status(401).json({ error: 'missing_token' });
    const { rows } = await pool.query('SELECT roles FROM users WHERE id = $1', [req.user.sub]);
    if (!rows[0]?.roles?.includes(role)) {
      return res.status(403).json({ error: 'forbidden', needs_role: role });
    }
    next();
  };
}
