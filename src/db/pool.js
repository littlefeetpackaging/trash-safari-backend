import pg from 'pg';
import 'dotenv/config';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Render's managed Postgres requires SSL for external connections; the
  // internal connection string (used when app + db are both on Render)
  // doesn't need it, so this is safe either way.
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : undefined,
});
