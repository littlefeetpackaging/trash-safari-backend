import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth } from '../lib/auth.js';

const router = Router();

// Resolves the open question flagged in doc §2 / the doc comment: collector
// isn't a role you get by self-selecting at signup (auth.js strips it out
// on purpose). Instead a user applies, an admin reviews it, and only then
// does 'collector' get added to their roles (see routes/admin.js).
const applySchema = z.object({
  real_name: z.string().min(1).max(120),
  phone: z.string().min(7).max(20),
  note: z.string().max(500).optional(),
});

router.post('/', requireAuth, async (req, res) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });

  const { rows } = await pool.query(
    `UPDATE users
     SET collector_status = 'pending', collector_applied_at = now()
     WHERE id = $1 AND collector_status IN ('none', 'rejected')
     RETURNING id, collector_status, collector_applied_at`,
    [req.user.sub]
  );
  if (!rows[0]) return res.status(409).json({ error: 'application_already_pending_or_approved' });

  // real_name/phone aren't modeled as their own columns yet — for a first
  // pass they'd typically go to a lightweight admin-notification (email/
  // Slack webhook) alongside this status flip, reviewed by a human in the
  // admin panel (doc §10). Wiring that notification is the next step once
  // there's a real admin panel to review from.
  res.status(202).json({ status: rows[0].collector_status, applied_at: rows[0].collector_applied_at });
});

export default router;
