# Trash Safari — Backend

Node/Express API implementing the schema and logic from the "Trash Safari —
Backend & Database Design" doc: Users, Reports, Verifications, Pickups,
PointsLedger, dedup matching, and the points economy.

## What's here

```
migrations/001_init.sql   the five-table schema (+ sponsor_orgs, routes)
src/db/                   Postgres connection pool + migration runner
src/lib/auth.js           JWT issue/verify middleware
src/lib/points.js         PointsLedger writes + balance queries
src/routes/               auth, users, reports, verifications, pickups, uploads
src/server.js             Express app entrypoint
render.yaml               one-click Render Blueprint (web service + Postgres)
```

## API summary

| Route | Auth | What it does |
|---|---|---|
| `POST /auth/signup` | — | create a user; requires `age_confirmed_18: true` and `terms_accepted: true` (see Terms & safety below) |
| `POST /auth/login` | — | returns `{ user, token }` |
| `GET /users/me` | Bearer | profile + cached scores + points balance |
| `POST /reports` | Bearer | submit a report; auto-dedups against nearby pending reports |
| `GET /reports/nearby?lat=&lng=` | Bearer | pending reports near a point, for the collector map |
| `POST /verifications` | Bearer, role `collector` | confirm/dispute a report |
| `POST /pickups` | Bearer, role `collector` | bundle your own confirmed verifications into one pickup |
| `POST /uploads/photo-upload-url?size_bytes=N` | Bearer | get a signed URL to upload a photo directly to object storage; rejects with `413` above 5MB |
| `POST /collector-application` | Bearer | apply to become a collector (real name + phone) — sets `collector_status: pending` for an admin to review |
| `POST /ads/complete` | Bearer | credit points for a watched rewarded ad (capped at 5/day) — **see the AdMob SSV warning in `src/routes/ads.js` before shipping this live** |
| `GET /leaderboard?scope=spotter\|impact&period=alltime\|weekly\|monthly` | Bearer | ranked users |
| `GET /achievements?unseen=true` | Bearer | badges earned; `POST /achievements/seen` marks them shown |
| `GET /admin/stats` | Bearer, role `admin` | report/verification/pickup counts, flagged disputes |
| `GET /admin/collector-applications` | Bearer, role `admin` | pending collector vetting queue |
| `POST /admin/collector-applications/:userId/review` | Bearer, role `admin` | `{ decision: "approved" \| "rejected" }` |
| `POST /admin/points/adjust` | Bearer, role `admin` | `{ user_id, delta, score_field }` — writes an audited `admin_adjustment` ledger row |

### Becoming the first admin

There's no signup path to `admin` — it's a deliberately manual step:

```sql
UPDATE users SET roles = array_append(roles, 'admin') WHERE email = 'you@example.com';
```

Run that once against the production database (Render's dashboard has a
built-in SQL console under the database's **Connect** tab), and that account
can review collector applications and adjust points from then on.

### Photo size limits

Client-side, the game already compresses the capture snapshot before
upload. Server-side, `/uploads/photo-upload-url` requires the caller to
state the exact upload size and rejects anything over 5MB with a `413` —
this is enforced by R2 itself (the size is baked into the signed URL), not
just trusted from the client. At a realistic compressed size (~100-300KB
per photo), the free 10GB R2 tier holds roughly 50,000 reports before any
storage cost kicks in.

### Wiring up the game (`trash-safari-standalone.html`)

The game now calls this API directly — signup/login gate, real report
submission per capture (when logged in and the browser has a GPS fix),
a leaderboard modal, and a "watch an ad for bonus points" button. To point
it at your deployed backend, open `trash-safari-player-screen.html`
(the source file `rebuild.py` bundles into the standalone version) and
change one line near the top of its `<script>`:

```js
const API_BASE_URL='https://CHANGE-ME.onrender.com';
```

to your actual Render URL, then re-run `python3 rebuild.py` to regenerate
`trash-safari-standalone.html`. Until you do that, the game still plays
completely fine in **offline demo mode** — every network call fails
silently and falls back to the old local-only scoring, so nothing is
broken by leaving the placeholder in.

Two things that are real but intentionally minimal in this pass:

- **The rewarded-ad button is a mock** — it shows a 5-second countdown and
  then calls `/ads/complete` directly. It proves the points-crediting flow
  end to end, but a real ad never plays. Swapping in an actual rewarded-ad
  SDK (see doc §11) is separate follow-up work.
- **There's no collector-side screen yet.** This file is the spotter/camera
  screen only, so it can submit Reports but there's nothing yet for a
  collector to browse nearby reports and confirm them (`/verifications`).
  That's a second screen to design and build, not something squeezed into
  this one.

### Terms & safety (doc §13)

Signup rejects with `400` unless both `age_confirmed_18` and
`terms_accepted` are sent as `true`. The actual rules text (18+ requirement,
no use while driving/crossing streets, supervising children, staying off
private property, the liability waiver, etc.) lives in the design doc, not
hardcoded here — it's meant to be shown as real UI copy at signup and
reviewed by a lawyer before launch, not baked into the API as a string.

## Setup — step by step

### 1. Push this to GitHub

```bash
cd trash-safari-backend
git add -A
git commit -m "Initial backend scaffold"
```

Then on github.com: **New repository** → name it (e.g. `trash-safari-backend`)
→ **Create repository**, leaving it empty (no README/gitignore — you already
have one). GitHub will show you a remote URL; run the two commands it gives
you, which look like:

```bash
git remote add origin https://github.com/<you>/trash-safari-backend.git
git push -u origin main
```

### 2. Create the object storage bucket (Cloudflare R2)

1. In the Cloudflare dashboard: **R2** → **Create bucket** → name it
   `trash-safari-photos`.
2. **Manage R2 API Tokens** → create a token with read/write access to that
   bucket. Save the **Access Key ID** and **Secret Access Key** — you'll
   paste these into Render in step 4.
3. Under the bucket's **Settings**, enable public access (or put a
   Cloudflare custom domain in front of it) and note the public base URL —
   that's `S3_PUBLIC_BASE_URL`.
4. Your `S3_ENDPOINT` is `https://<your-account-id>.r2.cloudflarestorage.com`
   (the account ID is shown in the R2 dashboard sidebar). `S3_REGION` is
   `auto`.

(AWS S3 works the same way if you'd rather use that — same env vars, just
point `S3_ENDPOINT` at AWS instead and use an IAM user's keys.)

### 3. Deploy to Render

1. On render.com: **New +** → **Blueprint** → connect the GitHub repo you
   just pushed. Render reads `render.yaml` and proposes a web service plus a
   free Postgres database — click **Apply**.
2. Once created, open the web service → **Environment** and fill in the five
   `S3_*` values from step 2 (they're left blank in `render.yaml` on
   purpose — secrets don't belong in a committed file). `DATABASE_URL` and
   `JWT_SECRET` are already filled in automatically.
3. Render builds and deploys. The start command (`npm run migrate && npm
   start`) runs the schema migration against the new database automatically
   on first boot — no manual `psql` step needed.
4. Once it's live, `GET https://<your-service>.onrender.com/health` should
   return `{"ok":true}`.

### 4. Point the game at it

The standalone HTML file currently simulates everything client-side. Wiring
it to this backend (replacing the in-memory score updates with real
`fetch()` calls to these endpoints) is the next piece of work — happy to do
that next once the backend above is live and you've confirmed the URL.

## Local development

```bash
cp .env.example .env   # fill in a local DATABASE_URL at minimum
npm install
npm run migrate
npm run dev
```
