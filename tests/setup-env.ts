/**
 * Loads `.env.local` before any test runs.
 *
 * Only the integration suites read anything from it — the PGlite tests are
 * deliberately self-contained so `npm test` works on a fresh clone with no
 * credentials at all. Without this, `TEST_DATABASE_URL` would have to be typed
 * onto the command line, which is how connection strings end up in shell
 * history.
 */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });
loadEnv();
