import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup-env.ts'],
    // Integration suites talk to Supabase in Mumbai; migrations in beforeAll
    // are many round trips.
    hookTimeout: 120_000,
    coverage: {
      include: ['src/core/**/*.ts'],
      exclude: ['src/core/**/index.ts'],
      thresholds: {
        // The brain is pure and fully testable. Hold it to a high bar.
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@lib': r('./src/lib'),
      '@db': r('./src/db'),
      '@adapters': r('./src/adapters'),
      '@ingest': r('./src/ingest'),
      '@messaging': r('./src/messaging'),
      '@workflows': r('./src/workflows'),
    },
  },
});
