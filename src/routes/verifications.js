import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth, requireCurrentRole } from '../lib/auth.js';
import { award } from '../lib/points.js';

const router = Router();

const createVerificationSchema = z.object({
  report_id: z.string().uuid(),
  confirm_photo_url: z.string().url().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  outcome: z.enum(['confirmed', 'disputed', 'not_found']),
  dispute_reason: z.string().max(500).optional(),
});

router.post('/', requireAuth, requireCurrentRole('collector'), async (req, res) => {
  const parsed = createVerificationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  const { report_id, confirm_photo_url, lat, lng, outcome, dispute_reason } = parsed.data;
  const collectorId = req.user.sub;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reportRes = await client.query('SELECT * FROM reports WHERE id = $1 FOR UPDATE', [report_id]);
    const report = reportRes.rows[0];
    if (!report) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'report_not_found' });
    }
    if (report.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'report_not_pending', status: report.status });
    }

    const { rows } = await client.query(
      `INSERT INTO verifications (report_id, collector_id, confirm_photo_url, lat, lng, outcome, dispute_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [report_id, collectorId, confirm_photo_url ?? null, lat ?? null, lng ?? null, outcome, dispute_reason ?? null]
    );
    const verification = rows[0];

    if (outcome === 'confirmed') {
      await client.query(`UPDATE reports SET status = 'verified' WHERE id = $1`, [report_id]);
      // The extra +15 on top of the +5 already awarded at submission (doc §8).
      await award(client, { userId: report.spotter_id, reason: 'report_verified', sourceId: report.id, scoreField: 'impact_score' });
    }
    // disputed / not_found: report stays pending so another collector can
    // still try, or it eventually expires via the sweep job (doc §7).

    await client.query('COMMIT');
    res.status(201).json({ verification });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

export default router;
