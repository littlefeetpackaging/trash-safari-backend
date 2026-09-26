import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth, requireCurrentRole } from '../lib/auth.js';
import { award } from '../lib/points.js';

const router = Router();

// Every route below requires the 'admin' role, re-checked against the
// database on every call (see lib/auth.js's requireCurrentRole for why:
// admin access needs to disappear immediately if it's revoked, not after a
// 30-day-old token expires). There's no self-serve way to become an admin —
// the first one is set directly in the database, and admins grant it to
// others from here going forward once that endpoint is worth building.
router.use(requireAuth, requireCurrentRole('admin'));

// ---------------------------------------------------------------------
// Points adjustment
// ---------------------------------------------------------------------
const adjustSchema = z.object({
  user_id: z.string().uuid(),
  delta: z.number().int().refine(n => n !== 0, 'delta must not be zero'),
  reason_note: z.string().max(500).optional(),
  score_field: z.enum(['spotter_score', 'impact_score']).default('impact_score'),
});

router.post('/points/adjust', async (req, res) => {
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  const { user_id, delta, score_field } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // award() only handles fixed POINTS[reason] values; admin_adjustment is
    // the one reason with an arbitrary, admin-chosen delta, so it's written
    // directly here rather than through that helper.
    await client.query(
      `INSERT INTO points_ledger (user_id, delta, reason, source_id) VALUES ($1, $2, 'admin_adjustment', $3)`,
      [user_id, delta, req.user.sub]
    );
    await client.query(`UPDATE users SET ${score_field} = ${score_field} + $2 WHERE id = $1`, [user_id, delta]);
    await client.query('COMMIT');
    res.json({ ok: true, user_id, delta });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// Collector vetting queue
// ---------------------------------------------------------------------
router.get('/collector-applications', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, display_name, collector_applied_at
     FROM users WHERE collector_status = 'pending'
     ORDER BY collector_applied_at ASC`
  );
  res.json({ applications: rows });
});

const reviewSchema = z.object({ decision: z.enum(['approved', 'rejected']) });

router.post('/collector-applications/:userId/review', async (req, res) => {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const { decision } = parsed.data;
  const { userId } = req.params;

  const { rows } = await pool.query(
    `UPDATE users
     SET collector_status = $2,
         collector_reviewed_by = $3,
         collector_reviewed_at = now(),
         roles = CASE WHEN $2 = 'approved' AND NOT ('collector' = ANY(roles))
                       THEN array_append(roles, 'collector') ELSE roles END
     WHERE id = $1 AND collector_status = 'pending'
     RETURNING id, roles, collector_status`,
    [userId, decision, req.user.sub]
  );
  if (!rows[0]) return res.status(404).json({ error: 'no_pending_application' });
  res.json({ user: rows[0] });
});

// ---------------------------------------------------------------------
// Aggregate stats
// ---------------------------------------------------------------------
router.get('/stats', async (_req, res) => {
  const [reports, verifications, pickups, users, disputes] = await Promise.all([
    pool.query(`SELECT status, COUNT(*)::int AS count FROM reports GROUP BY status`),
    pool.query(`SELECT outcome, COUNT(*)::int AS count FROM verifications GROUP BY outcome`),
    pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(total_weight_est), 0) AS total_weight_est FROM pickups`),
    pool.query(`SELECT COUNT(*)::int AS count FROM users`),
    pool.query(
      `SELECT r.id AS report_id, v.id AS verification_id, v.outcome, v.dispute_reason, v.collector_id, r.spotter_id, v.verified_at
       FROM verifications v JOIN reports r ON r.id = v.report_id
       WHERE v.outcome IN ('disputed', 'not_found')
       ORDER BY v.verified_at DESC LIMIT 50`
    ),
  ]);
  res.json({
    reports_by_status: reports.rows,
    verifications_by_outcome: verifications.rows,
    pickups: pickups.rows[0],
    total_users: users.rows[0].count,
    recent_flagged: disputes.rows,
  });
});

export default router;
