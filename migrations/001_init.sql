-- Trash Safari — initial schema
-- Mirrors the five-table design in "Trash Safari — Backend & Database Design"

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  roles           TEXT[] NOT NULL DEFAULT '{spotter}', -- e.g. {spotter}, {spotter,collector}
  home_lat        DOUBLE PRECISION,
  home_lng        DOUBLE PRECISION,
  spotter_score   INTEGER NOT NULL DEFAULT 0,           -- cached, derived from points_ledger
  impact_score    INTEGER NOT NULL DEFAULT 0,           -- cached, derived from points_ledger
  sponsor_org_id  UUID,                                 -- FK added below (sponsor_orgs created first)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sponsor_orgs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users
  ADD CONSTRAINT users_sponsor_org_fk
  FOREIGN KEY (sponsor_org_id) REFERENCES sponsor_orgs(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------
CREATE TYPE report_status AS ENUM ('pending', 'matched_existing', 'verified', 'expired');

CREATE TABLE reports (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spotter_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_used                 TEXT,
  material_guess            TEXT,                       -- 'plastic' | 'cardboard' | 'organic' (client-guessed)
  photo_url                 TEXT NOT NULL,
  lat                       DOUBLE PRECISION NOT NULL,
  lng                       DOUBLE PRECISION NOT NULL,
  gps_accuracy_m            DOUBLE PRECISION,
  captured_at               TIMESTAMPTZ NOT NULL,        -- device clock
  received_at               TIMESTAMPTZ NOT NULL DEFAULT now(), -- server clock
  status                    report_status NOT NULL DEFAULT 'pending',
  duplicate_of_report_id    UUID REFERENCES reports(id)
);

CREATE INDEX reports_status_idx ON reports(status);
CREATE INDEX reports_spotter_idx ON reports(spotter_id);
-- Nearby-pending lookups filter by status then scan lat/lng, so a plain btree
-- covering the query columns beats a full seq scan without needing PostGIS.
CREATE INDEX reports_lat_lng_idx ON reports(lat, lng) WHERE status = 'pending';

-- ---------------------------------------------------------------------
-- Verifications
-- ---------------------------------------------------------------------
CREATE TYPE verification_outcome AS ENUM ('confirmed', 'disputed', 'not_found');

CREATE TABLE verifications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id           UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  collector_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  confirm_photo_url   TEXT,
  lat                 DOUBLE PRECISION,
  lng                 DOUBLE PRECISION,
  outcome             verification_outcome NOT NULL,
  dispute_reason      TEXT,
  verified_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX verifications_report_idx ON verifications(report_id);
CREATE INDEX verifications_collector_idx ON verifications(collector_id);

-- ---------------------------------------------------------------------
-- Pickups
-- ---------------------------------------------------------------------
CREATE TABLE routes (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name  TEXT
);

CREATE TABLE pickups (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sponsor_org_id      UUID REFERENCES sponsor_orgs(id),
  verification_ids    UUID[] NOT NULL,
  total_weight_est    DOUBLE PRECISION,
  route_id            UUID REFERENCES routes(id),
  completed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX pickups_collector_idx ON pickups(collector_id);
CREATE INDEX pickups_sponsor_idx ON pickups(sponsor_org_id);

-- ---------------------------------------------------------------------
-- PointsLedger (append-only)
-- ---------------------------------------------------------------------
CREATE TYPE points_reason AS ENUM (
  'report_submitted',
  'report_verified',
  'pickup_completed',
  'streak_bonus',
  'redemption',
  'admin_adjustment'
);

CREATE TABLE points_ledger (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta       INTEGER NOT NULL,
  reason      points_reason NOT NULL,
  source_id   UUID, -- points at a Report, Verification, or Pickup row; no FK since the
                     -- referenced table varies by reason (enforced in application code)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX points_ledger_user_idx ON points_ledger(user_id);
