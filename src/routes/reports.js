import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth } from '../lib/auth.js';
import { award } from '../lib/points.js';

const router = Router();

// Doc §7 "Matching logic": fold a new report into an existing pending one
// within ~15-25m reported in the last 7-14 days, rather than scoring the
// same pile of trash multiple times.
const DEDUP_RADIUS_METERS = 20;
const DEDUP_WINDOW_DAYS = 10;

// Cheap flat-earth approximation — fine at the ~20m scale we're matching on,
// and avoids requiring PostGIS. Swap for ST_DWithin if this ever needs to be
// exact at longer ranges or near the poles.
const METERS_PER_DEGREE_LAT = 111_320;
function metersPerDegreeLng(lat) {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

const createReportSchema = z.object({
  tool_used: z.string().optional(),
  material_guess: z.enum(['plastic', 'cardboard', 'organic']).optional(),
  photo_url: z.string().url(),
  lat: z.number(),
  lng: z.number(),
  gps_accuracy_m: z.number().optional(),
  captured_at: z.string().datetime(),
});

router.post('/', requireAuth, async (req, res) => {
  const parsed = createReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  const { tool_used, material_guess, photo_url, lat, lng, gps_accuracy_m, captured_at } = parsed.data;
  const spotterId = req.user.sub;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dLat = DEDUP_RADIUS_METERS / METERS_PER_DEGREE_LAT;
    const dLng = DEDUP_RADIUS_METERS / metersPerDegreeLng(lat);
    const nearby = await client.query(
      `SELECT id FROM reports
       WHERE status = 'pending'
         AND received_at > now() - ($1 || ' days')::interval
         AND lat BETWEEN $2 - $3 AND $2 + $3
         AND lng BETWEEN $4 - $5 AND $4 + $5
       ORDER BY received_at ASC
       LIMIT 1`,
      [DEDUP_WINDOW_DAYS, lat, dLat, lng, dLng]
    );

    const duplicateOf = nearby.rows[0]?.id ?? null;
    const status = duplicateOf ? 'matched_existing' : 'pending';

    const { rows } = await client.query(
      `INSERT INTO reports
         (spotter_id, tool_used, material_guess, photo_url, lat, lng, gps_accuracy_m, captured_at, status, duplicate_of_report_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [spotterId, tool_used ?? null, material_guess ?? null, photo_url, lat, lng, gps_accuracy_m ?? null, captured_at, status, duplicateOf]
    );

    // Spotter Score rewards the spot itself even when it turns out to be a
    // duplicate of someone else's report — see doc §3, expired/duplicate
    // reports shouldn't feel punishing.
    await award(client, { userId: spotterId, reason: 'report_submitted', sourceId: rows[0].id, scoreField: 'spotter_score' });

    await client.query('COMMIT');
    res.status(201).json({ report: rows[0], duplicate: Boolean(duplicateOf) });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Nearby pending reports for a collector's map view.
router.get('/nearby', requireAuth, async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusMeters = Number(req.query.radius_m ?? 2000);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return res.status(400).json({ error: 'lat_lng_required' });

  const dLat = radiusMeters / METERS_PER_DEGREE_LAT;
  const dLng = radiusMeters / metersPerDegreeLng(lat);
  const { rows } = await pool.query(
    `SELECT * FROM reports
     WHERE status = 'pending'
       AND lat BETWEEN $1 - $2 AND $1 + $2
       AND lng BETWEEN $3 - $4 AND $3 + $4
     ORDER BY received_at ASC
     LIMIT 200`,
    [lat, dLat, lng, dLng]
  );
  res.json({ reports: rows });
});

export default router;
