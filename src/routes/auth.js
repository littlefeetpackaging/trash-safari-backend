import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { signToken } from '../lib/auth.js';
import { CURRENT_TERMS_VERSION } from '../lib/terms.js';

const router = Router();

// age_confirmed_18 and terms_accepted must both be sent as literal `true` —
// this is a legal attestation, not a UI nicety, so it's enforced here in
// the API, not just as a checkbox the client could forget to send (doc §13).
const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  display_name: z.string().min(1).max(60),
  roles: z.array(z.enum(['spotter', 'collector', 'sponsor'])).min(1).default(['spotter']),
  age_confirmed_18: z.literal(true, {
    errorMap: () => ({ message: 'You must confirm you are 18 or older to create an account.' }),
  }),
  terms_accepted: z.literal(true, {
    errorMap: () => ({ message: 'You must agree to the terms and safety rules to create an account.' }),
  }),
});

router.post('/signup', async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  const { email, password, display_name, roles } = parsed.data;

  // A brand-new account can never start with 'collector' pre-granted —
  // that role only follows the vetting flow in /collector-application
  // (doc §13's comment thread / §10 admin approval), regardless of what a
  // client sends here.
  const safeRoles = roles.filter(r => r !== 'collector');
  if (safeRoles.length === 0) safeRoles.push('spotter');

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length) return res.status(409).json({ error: 'email_taken' });

  const password_hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, roles, age_confirmed_18, terms_version, terms_accepted_at)
     VALUES ($1, $2, $3, $4, true, $5, now())
     RETURNING id, email, display_name, roles, spotter_score, impact_score, collector_status, created_at`,
    [email, password_hash, display_name, safeRoles, CURRENT_TERMS_VERSION]
  );
  const user = rows[0];
  res.status(201).json({ user, token: signToken(user) });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const { email, password } = parsed.data;

  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  delete user.password_hash;
  res.json({ user, token: signToken(user) });
});

export default router;
