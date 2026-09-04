/**
 * Who is allowed to open the console, and which merchants they may see.
 *
 * Until this table existed the dashboard had no authentication at all. Merchant
 * selection was a plain cookie any visitor could set, and the deployment is on
 * a public URL — so anyone who found it could read every case, every customer
 * contact and the abandoned-cart API key, flip send mode to live, and start a
 * recovery that messages real people. Nothing here is subtle; it simply was not
 * there.
 *
 * Two tables rather than one, and the split is deliberate even though there is
 * exactly one operator today. `merchant_members` is what makes "which accounts
 * can this person act on" a row in the database rather than an assumption in
 * the code. A single-user system that assumes the answer is "all of them" has
 * to be rewritten the first time it is not, and the rewrite touches every query
 * that resolves a merchant — which is all of them.
 */

import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { merchants } from './tenancy.js';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Lowercased on write. The login identifier. */
    email: text('email').notNull(),
    name: text('name'),

    /**
     * scrypt, as `scrypt$N$r$p$<salt>$<hash>`, all base64url.
     *
     * Never a bare digest. A password is low-entropy by nature, so the defence
     * is deliberate slowness — a fast hash like SHA-256 over a stolen table is
     * brute-forced offline at billions of guesses a second. The parameters are
     * stored beside the hash rather than hard-coded so they can be raised later
     * without invalidating every existing password.
     */
    passwordHash: text('password_hash').notNull(),

    /**
     * Bumped to invalidate every session this user has open.
     *
     * Sessions are stateless signed cookies, which means there is otherwise no
     * way to revoke one before it expires — a stolen laptop would stay logged
     * in for the life of the token. This value is carried inside the token and
     * re-checked on every request, so changing a password or forcing a sign-out
     * everywhere is one UPDATE.
     */
    sessionEpoch: text('session_epoch').notNull().default('1'),

    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete, so a departed operator's audit trail keeps a name against it. */
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  // UNIQUE, not merely indexed. Email is the login identifier, so two rows
  // sharing one would make "which user is this" depend on row order — and the
  // answer decides whose password is checked.
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

/**
 * Which merchants a user may act on.
 *
 * The composite primary key is the guard: one row per (user, merchant), so a
 * membership cannot be granted twice and `listMerchants` cannot return the same
 * account under two rows.
 */
export const merchantMembers = pgTable(
  'merchant_members',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    merchantId: uuid('merchant_id')
      .notNull()
      .references(() => merchants.id, { onDelete: 'cascade' }),

    /**
     * `owner` may change send mode and start recoveries; `viewer` may only read.
     *
     * Stored as text rather than an enum: this is the one vocabulary here that
     * is genuinely expected to grow, and adding a value to a Postgres enum is a
     * migration while adding one here is not. Unknown values are treated as
     * `viewer` by the reader, which is the safe direction.
     */
    role: text('role').notNull().default('owner'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.merchantId] }),
    index('merchant_members_merchant_idx').on(t.merchantId),
  ],
);
