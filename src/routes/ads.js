import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth } from '../lib/auth.js';
import { award } from '../lib/points.js';

const router = Router();

const DAILY_AD_CAP = 5;

// IMPORTANT (doc §11): this trusts ad_network_txn_id at face value, which is
// only safe once it's actually verified server-to-server against the ad
// network's callback/verification API (AdMob's server-side reward
// verification — SSV). Shipping this without that verification step means
// a modified client can call this endpoint directly and claim free points
// without ever showing an ad. Wiring the real AdMob SSV check is a
// follow-up, not optional before this goes live with real users.
const completeSchema = z.object({
  ad_network: z.string().default('admob'),
  ad_network_txn_id: z.string().min(1),
});

router.post('/complete', requireAuth, async (req, res) => {
  const parsed = completeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const { ad_network, ad_network_txn_id } = parsed.data;
  const userId = req.user.sub;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dup = await client.query(
      `SELECT id FROM ad_views WHERE ad_network = $1 AND ad_network_txn_id = $2`,
      [ad_network, ad_network_txn_id]
    );
    if (dup.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'ad_already_credited' });
    }

    const todayCount = await client.query(
      `SELECT COUNT(*)::int AS n FROM ad_views WHERE user_id = $1 AND watched_at > now() - interval '1 day'`,
      [userId]
    );
    if (todayCount.rows[0].n >= DAILY_AD_CAP) {
      await client.query('ROLLBACK');
      return res.status(429).json({ error: 'daily_ad_cap_reached', cap: DAILY_AD_CAP });
    }

    const delta = await award(client, { userId, reason: 'ad_watched', scoreField: 'spotter_score' });

    await client.query(
      `INSERT INTO ad_views (user_id, ad_network, ad_network_txn_id, points_awarded) VALUES ($1,$2,$3,$4)`,
      [userId, ad_network, ad_network_txn_id, delta]
    );

    await client.query('COMMIT');
    res.status(201).json({ points_awarded: delta });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

export default router;
