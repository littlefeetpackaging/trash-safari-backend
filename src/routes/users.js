import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../lib/auth.js';
import { balance } from '../lib/points.js';

const router = Router();

router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, display_name, roles, spotter_score, impact_score, created_at
     FROM users WHERE id = $1`,
    [req.user.sub]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });

  const client = await pool.connect();
  const points_balance = await balance(client, req.user.sub);
  client.release();

  res.json({ user: rows[0], points_balance });
});

export default router;
