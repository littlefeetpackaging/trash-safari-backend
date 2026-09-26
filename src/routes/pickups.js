import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth, requireCurrentRole } from '../lib/auth.js';
import { award } from '../lib/points.js';

const router = Router();

const createPickupSchema = z.object({
  verification_ids: z.array(z.string().uuid()).min(1),
  sponsor_org_id: z.string().uuid().optional(),
  total_weight_est: z.number().optional(),
  route_id: z.string().uuid().optional(),
});

// Bundles one or more of a collector's own "confirmed" Verifications from a
// single visit into a Pickup, and pays the per-item collector reward for
// each one (doc §5 and §8).
router.post('/', requireAuth, requireCurrentRole('collector'), async (req, res) => {
  const parsed = createPickupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  const { verification_ids, sponsor_org_id, total_weight_est, route_id } = parsed.data;
  const collectorId = req.user.sub;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: verifications } = await client.query(
      `SELECT * FROM verifications WHERE id = ANY($1::uuid[]) AND collector_id = $2 AND outcome = 'confirmed'`,
      [verification_ids, collectorId]
    );
    if (verifications.length !== verification_ids.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'invalid_verification_ids', note: 'must be your own confirmed verifications' });
    }

    const { rows } = await client.query(
      `INSERT INTO pickups (collector_id, sponsor_org_id, verification_ids, total_weight_est, route_id)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [collectorId, sponsor_org_id ?? null, verification_ids, total_weight_est ?? null, route_id ?? null]
    );
    const pickup = rows[0];

    for (const v of verifications) {
      await award(client, { userId: collectorId, reason: 'pickup_completed', sourceId: pickup.id, scoreField: 'impact_score' });
    }

    await client.query('COMMIT');
    res.status(201).json({ pickup });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

export default router;
