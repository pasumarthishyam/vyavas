/**
 * Console user administration.
 *
 * The only way an account gets into this system. Runs from a trusted machine
 * against the database — never a browser form, never a sign-up page. There is
 * no self-registration anywhere in the app, and that is the intent: a public
 * URL with a sign-up form is a public URL anyone can get an account on.
 *
 *   npm run user -- create --email you@example.com --password '…' --name 'Your Name'
 *   npm run user -- list
 *   npm run user -- password --email you@example.com --password '…'
 *   npm run user -- grant --email you@example.com --slug tradesmetrix
 *   npm run user -- revoke --email you@example.com --slug sandbox
 *
 * `create` maps EVERY existing merchant to the new user by default, because the
 * first account created on an existing deployment is the person who has been
 * operating it without a login. Pass `--no-claim` to create an account with no
 * merchants and grant them one at a time instead.
 *
 * Passwords are hashed with scrypt before they touch a column and are never
 * echoed back. Prefer passing one through an environment variable
 * (`VYAVAS_PASSWORD=…`) over an argument: a command line is visible to other
 * processes and lands in shell history.
 *
 * DO NOT pass `--password` through `npm run`. npm claims that flag, lowercases
 * the value and hands the script the mangled version — an account created that
 * way stores a hash of a password nobody typed, and every correct sign-in is
 * then refused with "Email or password is incorrect." `readPassword` refuses
 * that input now rather than hashing it; run the script through `npx tsx`, or
 * set VYAVAS_PASSWORD.
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { and, eq, sql } from 'drizzle-orm';

import { createClient } from '../src/db/client.js';
import { merchantMembers, users } from '../src/db/schema/auth.js';
import { merchants } from '../src/db/schema/tenancy.js';
import { hashPassword } from '../src/lib/password.js';

// ─── arg parsing ─────────────────────────────────────────────────────────────
//
// npm on Windows swallows `--flag=value` before it reaches process.argv, so
// every flag is read from argv AND from the npm_config_* variables npm sets.
// Same helper as scripts/merchant.ts, for the same reason.

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--')) return argv[i + 1];

  const eq_ = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq_) return eq_.slice(name.length + 3);

  const npm = process.env[`npm_config_${name.replace(/-/g, '_')}`];
  return npm && npm.length > 0 ? npm : undefined;
}

/**
 * argv only — never the `npm_config_*` fallback above.
 *
 * npm mangles the value it puts in `npm_config_password`: it lowercases it. An
 * account created with a mixed-case password through `npm run user` was stored
 * as the all-lowercase version of it, and then refused every correct sign-in
 * attempt with "Email or password is incorrect." Nothing downstream can see it —
 * a hash of the wrong string is a perfectly valid hash — so the fallback is
 * simply not available for the one value where case is load-bearing.
 */
function argvOnly(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--')) return argv[i + 1];

  const eq_ = argv.find((a) => a.startsWith(`--${name}=`));
  return eq_ ? eq_.slice(name.length + 3) : undefined;
}

function has(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function required(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`\n  Missing --${name}\n`);
    process.exit(1);
  }
  return v;
}

function readEmail(): string {
  const email = required('email').trim().toLowerCase();
  if (!email.includes('@')) {
    console.error('\n  --email does not look like an email address\n');
    process.exit(1);
  }
  return email;
}

/**
 * Argument first, then the environment — and deliberately NOT `npm_config_*`.
 *
 * See `argvOnly`. If npm ate the flag, say so instead of hashing whatever npm
 * left behind: the failure this prevents is silent, permanent, and looks like a
 * bug in the login page rather than in the command that created the account.
 */
function readPassword(): string {
  const password = argvOnly('password') ?? process.env.VYAVAS_PASSWORD ?? '';
  if (password.length === 0) {
    if (process.env.npm_config_password) {
      console.error(
        '\n  npm intercepted --password and rewrote it (it lowercases the value), so it is\n' +
          '  not safe to use. Run this without npm, or pass the password by environment:\n\n' +
          '    npx tsx scripts/user.ts <command> --email you@example.com\n' +
          '    (with VYAVAS_PASSWORD set in the environment)\n',
      );
      process.exit(1);
    }
    console.error('\n  Missing --password (or set VYAVAS_PASSWORD)\n');
    process.exit(1);
  }
  if (password.length < 12) {
    console.error('\n  Password must be at least 12 characters.\n');
    process.exit(1);
  }
  return password;
}

// ─── commands ────────────────────────────────────────────────────────────────

// `max: 1` — a one-shot CLI needs exactly one connection, and taking a pool
// would hold slots a serving instance may want.
const { db } = createClient({ max: 1 });

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === 'create') {
    const email = readEmail();
    const password = readPassword();
    const name = arg('name') ?? null;

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing.length > 0) {
      console.error(`\n  A user with email ${email} already exists. Use 'password' to change it.\n`);
      process.exit(1);
    }

    const [created] = await db
      .insert(users)
      .values({ email, name, passwordHash: await hashPassword(password) })
      .returning({ id: users.id });

    console.log(`\n  Created user ${email}`);

    /*
     * Claim every existing merchant.
     *
     * This deployment has been running without any login at all, so every
     * merchant already in the database belongs to whoever is creating the first
     * account. Without this step they would sign in successfully and see an
     * empty console, which looks exactly like data loss.
     *
     * `--no-claim` skips it for the second and later users, who should be
     * granted access one account at a time.
     */
    if (has('no-claim')) {
      console.log('  --no-claim: no merchants mapped. Use `grant` to add them.\n');
    } else {
      const all = await db
        .select({ id: merchants.id, name: merchants.name, slug: merchants.slug })
        .from(merchants)
        .where(sql`${merchants.deletedAt} is null`);

      if (all.length === 0) {
        console.log('  No merchants exist yet. Create one with `npm run merchant -- create`.\n');
      } else {
        await db
          .insert(merchantMembers)
          .values(
            all.map((m: { id: string }) => ({
              userId: created!.id,
              merchantId: m.id,
              role: 'owner',
            })),
          )
          .onConflictDoNothing();
        console.log(`  Mapped ${all.length} merchant(s):`);
        for (const m of all) console.log(`    - ${m.name} (${m.slug})`);
        console.log('');
      }
    }

    if (!process.env.SESSION_SECRET) {
      console.log('  ⚠  SESSION_SECRET is not set, so nobody can sign in yet. Generate one with:');
      console.log("     node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"");
      console.log('     then set it in .env.local and in the deployment environment.\n');
    }
    return;
  }

  if (command === 'list') {
    const rows = await db
      .select({
        email: users.email,
        name: users.name,
        lastLoginAt: users.lastLoginAt,
        disabledAt: users.disabledAt,
        merchantCount: sql<number>`(
          select count(*) from merchant_members mm where mm.user_id = ${users.id}
        )::int`,
      })
      .from(users)
      .orderBy(users.createdAt);

    if (rows.length === 0) {
      console.log('\n  No users. Create one with `npm run user -- create --email … --password …`\n');
      return;
    }

    console.log('');
    for (const r of rows) {
      const status = r.disabledAt ? ' [DISABLED]' : '';
      const last = r.lastLoginAt ? r.lastLoginAt.toISOString().slice(0, 16).replace('T', ' ') : 'never';
      console.log(`  ${r.email}${status}`);
      console.log(`    name: ${r.name ?? '—'}   merchants: ${r.merchantCount}   last login: ${last}`);
    }
    console.log('');
    return;
  }

  if (command === 'password') {
    const email = readEmail();
    const password = readPassword();

    // Bumping the epoch is the point, not a side effect: sessions are stateless
    // signed tokens, so a password change that left the epoch alone would leave
    // every already-issued session working until it expired on its own.
    const updated = await db
      .update(users)
      .set({
        passwordHash: await hashPassword(password),
        sessionEpoch: sql`(${users.sessionEpoch}::bigint + 1)::text`,
        updatedAt: sql`now()`,
      })
      .where(eq(users.email, email))
      .returning({ id: users.id });

    if (updated.length === 0) {
      console.error(`\n  No user with email ${email}\n`);
      process.exit(1);
    }
    console.log(`\n  Password changed for ${email}. Every existing session is now signed out.\n`);
    return;
  }

  if (command === 'grant' || command === 'revoke') {
    const email = readEmail();
    const slug = required('slug');

    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (!user) {
      console.error(`\n  No user with email ${email}\n`);
      process.exit(1);
    }

    const [merchant] = await db
      .select({ id: merchants.id, name: merchants.name })
      .from(merchants)
      .where(and(eq(merchants.slug, slug), sql`${merchants.deletedAt} is null`));
    if (!merchant) {
      console.error(`\n  No merchant with slug ${slug}\n`);
      process.exit(1);
    }

    if (command === 'grant') {
      await db
        .insert(merchantMembers)
        .values({ userId: user.id, merchantId: merchant.id, role: arg('role') ?? 'owner' })
        .onConflictDoNothing();
      console.log(`\n  ${email} can now act on ${merchant.name} (${slug}).\n`);
    } else {
      await db
        .delete(merchantMembers)
        .where(
          and(eq(merchantMembers.userId, user.id), eq(merchantMembers.merchantId, merchant.id)),
        );
      console.log(`\n  ${email} can no longer act on ${merchant.name} (${slug}).\n`);
    }
    return;
  }

  console.log(`
  Usage:
    npm run user -- create   --email <email> --password <pw> [--name <name>] [--no-claim]
    npm run user -- list
    npm run user -- password --email <email> --password <pw>
    npm run user -- grant    --email <email> --slug <merchant-slug> [--role owner|viewer]
    npm run user -- revoke   --email <email> --slug <merchant-slug>

  On PowerShell the '--' separator is swallowed by npm. Use:
    npx tsx scripts/user.ts create --email you@example.com --password '…'
`);
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
