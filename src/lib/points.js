// Central place for the point values from doc §8 (+ §11's ad_watched), so
// scoring logic never gets hand-rolled inline at each call site. Award
// writes a PointsLedger row and bumps the cached spotter_score/impact_score
// in the same transaction (the ledger row is the source of truth; the
// cached column is just so the app doesn't have to SUM() on every profile
// view), then checks achievement thresholds (doc §12).
const POINTS = {
  report_submitted: 5,
  report_verified: 15, // on top of the 5 already given at submission (5 + 15 = 20 total)
  pickup_completed: 25, // per item, applied once per verification bundled into the pickup
  streak_bonus: 10,
  ad_watched: 4, // deliberately less than a verified report — watching ads should never
                 // out-earn actually finding trash (doc §11)
};

// Badge thresholds, checked against a fresh COUNT/SUM after every award.
// Defined in code (not the database) since these get retuned as the game
// is balanced — see doc §12.
const BADGE_RULES = [
  { code: 'first_report', check: (s) => s.reports_submitted >= 1 },
  { code: 'first_verified', check: (s) => s.reports_verified >= 1 },
  { code: '10_verified', check: (s) => s.reports_verified >= 10 },
  { code: '100_verified', check: (s) => s.reports_verified >= 100 },
  { code: 'first_pickup', check: (s) => s.pickups_completed >= 1 },
  { code: '50_pickups', check: (s) => s.pickups_completed >= 50 },
];

export async function award(client, { userId, reason, sourceId, scoreField }) {
  const delta = POINTS[reason];
  if (delta === undefined) throw new Error(`no point value configured for reason "${reason}"`);

  await client.query(
    `INSERT INTO points_ledger (user_id, delta, reason, source_id) VALUES ($1, $2, $3, $4)`,
    [userId, delta, reason, sourceId ?? null]
  );

  if (scoreField) {
    await client.query(
      `UPDATE users SET ${scoreField} = ${scoreField} + $2 WHERE id = $1`,
      [userId, delta]
    );
  }

  await checkAchievements(client, userId);
  return delta;
}

export async function balance(client, userId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(delta), 0)::int AS balance FROM points_ledger WHERE user_id = $1`,
    [userId]
  );
  return rows[0].balance;
}

async function checkAchievements(client, userId) {
  const { rows } = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE reason = 'report_submitted')::int AS reports_submitted,
       COUNT(*) FILTER (WHERE reason = 'report_verified')::int AS reports_verified,
       COUNT(*) FILTER (WHERE reason = 'pickup_completed')::int AS pickups_completed
     FROM points_ledger WHERE user_id = $1`,
    [userId]
  );
  const stats = rows[0];

  for (const rule of BADGE_RULES) {
    if (rule.check(stats)) {
      // ON CONFLICT DO NOTHING: badges are earned once (unique constraint on
      // user_id+badge_code), so re-checking after every award is cheap and
      // idempotent rather than needing a "did they already have this" read first.
      await client.query(
        `INSERT INTO achievements (user_id, badge_code) VALUES ($1, $2)
         ON CONFLICT (user_id, badge_code) DO NOTHING`,
        [userId, rule.code]
      );
    }
  }
}
