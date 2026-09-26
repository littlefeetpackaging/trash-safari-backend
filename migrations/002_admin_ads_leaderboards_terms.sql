-- Adds: admin role support (no schema change needed, 'admin' is just another
-- value in users.roles), collector vetting status, ad-funded points,
-- achievements, and the signup terms/age-gate fields.

-- ---------------------------------------------------------------------
-- Signup terms & age gate (doc §13)
-- ---------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN age_confirmed_18 BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN terms_version    TEXT,
  ADD COLUMN terms_accepted_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- Collector vetting (resolves the open question from §2 / the doc comment)
-- ---------------------------------------------------------------------
CREATE TYPE collector_status AS ENUM ('none', 'pending', 'approved', 'rejected');

ALTER TABLE users
  ADD COLUMN collector_status collector_status NOT NULL DEFAULT 'none',
  ADD COLUMN collector_applied_at TIMESTAMPTZ,
  ADD COLUMN collector_reviewed_by UUID REFERENCES users(id),
  ADD COLUMN collector_reviewed_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- Advertising & sponsor funding (doc §11)
-- ---------------------------------------------------------------------
CREATE TABLE ad_views (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ad_network          TEXT NOT NULL DEFAULT 'admob',
  ad_network_txn_id   TEXT,
  sponsor_org_id      UUID REFERENCES sponsor_orgs(id),
  points_awarded      INTEGER NOT NULL,
  watched_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ad_views_user_idx ON ad_views(user_id);
-- Enforces the daily-cap check efficiently (doc §11: capped so ad-watching
-- never out-earns actually finding trash).
CREATE INDEX ad_views_user_watched_at_idx ON ad_views(user_id, watched_at);

-- New PointsLedger reason for ad-funded points. Postgres requires adding
-- enum values outside a transaction block in older versions; the migration
-- runner wraps each file in BEGIN/COMMIT, which is fine on Postgres 12+
-- (ADD VALUE is transactional since PG12, which Render's managed Postgres is).
ALTER TYPE points_reason ADD VALUE 'ad_watched';

-- Sponsor orgs get a fundable points budget for direct-funding campaigns
-- (doc §11's "Acme Corp is funding 10,000 points this month" case).
ALTER TABLE sponsor_orgs
  ADD COLUMN points_budget_remaining INTEGER;

-- ---------------------------------------------------------------------
-- Leaderboards & achievements (doc §12)
-- ---------------------------------------------------------------------
CREATE TABLE achievements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_code  TEXT NOT NULL,
  earned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at     TIMESTAMPTZ, -- null until the app has shown the "you earned a badge!" toast
  UNIQUE (user_id, badge_code) -- a badge is earned once
);

CREATE INDEX achievements_user_idx ON achievements(user_id);
CREATE INDEX achievements_unseen_idx ON achievements(user_id) WHERE seen_at IS NULL;
