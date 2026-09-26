import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../lib/auth.js';

const router = Router();

// GET /achievements?unseen=true — the app polls this on open, shows a
// "you earned a badge!" toast for each row, then calls POST /achievements/seen
// to mark them shown (doc §12).
router.get('/', requireAuth, async (req, res) => {
  const onlyUnseen = req.query.unseen === 'true';
  const { rows } = await pool.query(
    `SELECT id, badge_code, earned_at, seen_at FROM achievements
     WHERE user_id = $1 ${onlyUnseen ? 'AND seen_at IS NULL' : ''}
     ORDER BY earned_at DESC`,
    [req.user.sub]
  );
  res.json({ achievements: rows });
});

router.post('/seen', requireAuth, async (req, res) => {
  await pool.query(
    `UPDATE achievements SET seen_at = now() WHERE user_id = $1 AND seen_at IS NULL`,
    [req.user.sub]
  );
  res.json({ ok: true });
});

export default router;
