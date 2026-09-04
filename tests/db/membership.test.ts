/**
 * Membership scoping.
 *
 * The console picks its merchant from a cookie, which the browser sets and an
 * attacker therefore controls. Everything here is about the join that turns
 * that cookie from a grant into a request: a signed-in user asking for a
 * merchant they are not a member of must get nothing, not that merchant.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { getConsoleMerchantBySlug } from '../../src/db/queries/recovery.js';
import { merchantIdsFor, userCanAccessMerchant } from '../../src/lib/auth.js';
import { hashPassword } from '../../src/lib/password.js';
import { createTestDb, schema, seedMerchant, type TestDb } from './harness.js';

let t: TestDb;
let aliceId: string;
let bobId: string;
let liveId: string;
let sandboxId: string;

async function seedUser(email: string): Promise<string> {
  const [row] = await t.db
    .insert(schema.users)
    .values({ email, passwordHash: await hashPassword('correct horse battery') })
    .returning({ id: schema.users.id });
  return row!.id;
}

beforeEach(async () => {
  t = await createTestDb();

  liveId = await seedMerchant(t.db, { slug: 'live-account', name: 'Live Account' });
  sandboxId = await seedMerchant(t.db, { slug: 'sandbox', name: 'Sandbox' });

  aliceId = await seedUser('alice@example.com');
  bobId = await seedUser('bob@example.com');

  // Alice runs both accounts. Bob only has the sandbox.
  await t.db.insert(schema.merchantMembers).values([
    { userId: aliceId, merchantId: liveId },
    { userId: aliceId, merchantId: sandboxId },
    { userId: bobId, merchantId: sandboxId },
  ]);
});

afterEach(async () => {
  await t.close();
});

describe('the merchant cookie is a request, not a grant', () => {
  it('gives a member the merchant they asked for', async () => {
    const m = await getConsoleMerchantBySlug(t.db, 'sandbox', aliceId);
    expect(m?.id).toBe(sandboxId);
  });

  it('REFUSES a merchant the user is not a member of', async () => {
    // The attack: Bob edits one cookie value to the live account's slug. He is
    // signed in, so the middleware lets the request through; this join is what
    // stops him reading the live account's cases and flipping its send mode.
    const m = await getConsoleMerchantBySlug(t.db, 'live-account', bobId);
    expect(m?.id).not.toBe(liveId);
    // Falls back to a merchant he DOES have, never to the one he asked for.
    expect(m?.id).toBe(sandboxId);
  });

  it('falls back to the first accessible merchant, never to none, for an unknown slug', async () => {
    const m = await getConsoleMerchantBySlug(t.db, 'no-such-slug', aliceId);
    expect(m).not.toBeNull();
    expect([liveId, sandboxId]).toContain(m!.id);
  });

  it('returns null for a user who is a member of nothing', async () => {
    const orphan = await seedUser('orphan@example.com');
    expect(await getConsoleMerchantBySlug(t.db, 'sandbox', orphan)).toBeNull();
    // Emphatically not "the first merchant". An account with no memberships
    // must see an empty console, not somebody else's.
    expect(await getConsoleMerchantBySlug(t.db, null, orphan)).toBeNull();
  });

  it('excludes a soft-deleted merchant', async () => {
    await t.db
      .update(schema.merchants)
      .set({ deletedAt: new Date() })
      .where(eq(schema.merchants.id, sandboxId));

    const m = await getConsoleMerchantBySlug(t.db, 'sandbox', bobId);
    expect(m).toBeNull();
  });
});

describe('membership lookups', () => {
  it('answers yes only for a real membership', async () => {
    expect(await userCanAccessMerchant(t.db, aliceId, liveId)).toBe(true);
    expect(await userCanAccessMerchant(t.db, bobId, sandboxId)).toBe(true);
    expect(await userCanAccessMerchant(t.db, bobId, liveId)).toBe(false);
  });

  it('lists exactly the merchants a user belongs to', async () => {
    expect((await merchantIdsFor(t.db, aliceId)).sort()).toEqual([liveId, sandboxId].sort());
    expect(await merchantIdsFor(t.db, bobId)).toEqual([sandboxId]);
  });

  it('drops memberships when the merchant is deleted', async () => {
    // ON DELETE CASCADE. A membership row pointing at a merchant that no longer
    // exists would make every join here quietly wrong.
    await t.db.delete(schema.merchants).where(eq(schema.merchants.id, sandboxId));
    expect(await merchantIdsFor(t.db, bobId)).toEqual([]);
    expect(await merchantIdsFor(t.db, aliceId)).toEqual([liveId]);
  });
});

describe('the users table', () => {
  it('refuses two accounts on one email', async () => {
    // Email is the login identifier. Two rows sharing it would make "which
    // user is this" depend on row order, and that answer decides whose password
    // is checked.
    await expect(seedUser('alice@example.com')).rejects.toThrow();
  });

  it('starts every user on a session epoch', async () => {
    const [row] = await t.db
      .select({ epoch: schema.users.sessionEpoch })
      .from(schema.users)
      .where(eq(schema.users.id, aliceId));
    expect(row!.epoch).toBe('1');
  });
});
