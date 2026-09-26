import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../lib/auth.js';

const router = Router();

// GET /leaderboard?scope=spotter|impact&period=alltime|weekly|monthly
router.get('/', requireAuth, async (req, res) => {
  const scope = req.query.scope === 'impact' ? 'impact_score' : 'spotter_score';
  const period = req.query.period ?? 'alltime';

  if (period === 'alltime') {
    const { rows } = await pool.query(
      `SELECT id, display_name, ${scope} AS score
       FROM users ORDER BY ${scope} DESC LIMIT 50`
    );
    return res.json({ scope, period, leaders: rows });
  }

  // Weekly/monthly boards sum recent PointsLedger deltas instead of the
  // cached lifetime score, so they reset naturally without any cron job
  // zeroing a column out (doc §12).
  const reasonFilter = scope === 'spotter_score'
    ? `reason IN ('report_submitted', 'ad_watched', 'streak_bonus')`
    : `reason IN ('report_verified', 'pickup_completed', 'streak_bonus')`;
  const days = period === 'monthly' ? 30 : 7;

  const { rows } = await pool.query(
    `SELECT u.id, u.display_name, SUM(pl.delta)::int AS score
     FROM points_ledger pl
     JOIN users u ON u.id = pl.user_id
     WHERE pl.created_at > now() - ($1 || ' days')::interval AND ${reasonFilter}
     GROUP BY u.id, u.display_name
     ORDER BY score DESC
     LIMIT 50`,
    [days]
  );
  res.json({ scope, period, leaders: rows });
});

export default router;
