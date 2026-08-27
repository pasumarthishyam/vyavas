import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// `.env.local` holds the real credentials and is gitignored. `.env` is a
// fallback for CI, where secrets arrive as environment variables instead.
loadEnv({ path: '.env.local' });
loadEnv();

/**
 * Migrations run over the DIRECT connection (port 5432), not the pooler.
 *
 * Supavisor's transaction mode (6543) cannot hold the session state that DDL
 * and advisory locks need, so `drizzle-kit push`/`migrate` through it fails in
 * confusing ways. The app uses the pooler; migrations use direct.
 */
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
});
