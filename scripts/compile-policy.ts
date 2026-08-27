/**
 * YAML policy table -> generated TypeScript.
 *
 * `src/core` is not permitted to read files, so the table cannot be loaded at
 * runtime from within core. Instead the YAML is the source of truth, this
 * script compiles it, and `src/core/policy/generated.ts` is the committed
 * artefact core imports.
 *
 * The generated file is checked into git and a test asserts it matches a fresh
 * compile of the YAML, so the two can never drift apart unnoticed.
 *
 *   npm run policy:build    regenerate after editing any YAML
 *   npm run policy:check    verify the committed artefact is current
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

import { compilePolicyTable, PolicyCompileError } from '../src/core/policy/compile.js';

const TABLE_DIR = resolve(process.cwd(), 'src/core/policy/table');
export const OUT_FILE = resolve(process.cwd(), 'src/core/policy/generated.ts');

export function readYamlRows(): unknown[] {
  const files = readdirSync(TABLE_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort(); // deterministic order so the generated file is stable

  const rows: unknown[] = [];
  for (const file of files) {
    const text = readFileSync(join(TABLE_DIR, file), 'utf8');
    const parsed: unknown = parse(text);
    if (parsed == null) continue; // a file of nothing but comments
    if (!Array.isArray(parsed)) {
      throw new Error(`${file} must contain a YAML list of policy rows`);
    }
    rows.push(...parsed);
  }
  return rows;
}

export function renderGenerated(rows: readonly unknown[]): string {
  return `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: src/core/policy/table/*.yaml
 * Rebuild: npm run policy:build
 *
 * Committed so that src/core can import the table without reading the
 * filesystem, which core is not permitted to do. A test verifies this file
 * matches a fresh compile of the YAML.
 */

export const RAW_POLICY_ROWS: readonly unknown[] = ${JSON.stringify(rows, null, 2)};
`;
}

function main(): void {
  const check = process.argv.includes('--check');
  const rows = readYamlRows();

  // Compile before writing: a table that fails its integrity checks must never
  // reach the generated artefact.
  try {
    const compiled = compilePolicyTable(rows);
    console.log(`Compiled ${compiled.length} policy rows.`);
  } catch (e) {
    if (e instanceof PolicyCompileError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const next = renderGenerated(rows);

  if (check) {
    const current = readFileSync(OUT_FILE, 'utf8');
    if (current !== next) {
      console.error(
        'src/core/policy/generated.ts is out of date with the YAML table.\n' +
          'Run: npm run policy:build',
      );
      process.exit(1);
    }
    console.log('generated.ts is up to date.');
    return;
  }

  writeFileSync(OUT_FILE, next, 'utf8');
  console.log(`Wrote ${OUT_FILE}`);
}

// Only run when invoked directly — the drift-guard test imports readYamlRows()
// and renderGenerated() from here, and must not trigger a write.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
