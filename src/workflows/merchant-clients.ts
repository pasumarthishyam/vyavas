/**
 * Provider clients, resolved for one merchant.
 *
 * The single entry point between "I have a merchantId" and "I can talk to
 * Razorpay or send a message". Both functions take the merchant explicitly, so
 * there is no way to reach a provider without having named whose account it is.
 *
 * That is the whole point. The previous shape — a module-level `getChannels()`
 * reading global env — worked perfectly for one merchant and would have sent a
 * sandbox test message on a live merchant's account the moment there were two,
 * with nothing in the type system or the tests to notice.
 */

import type { Database } from '../db/client.js';
import { loadMerchantCredentials, type MerchantCredentials } from '../db/repos/credentials.js';
import { createRazorpayClient, type RazorpayClient } from '../adapters/razorpay/client.js';
import { getChannelsFor, type SendChannels } from './channels.js';

/**
 * The channels this merchant sends on, with its own routing applied.
 *
 * Returns empty channels for an unknown merchant rather than throwing: a
 * missing merchant is a data problem, and every rung that finds no channel
 * already reports itself honestly as `skipped` with a reason.
 */
export async function channelsForMerchant(
  db: Database,
  merchantId: string,
): Promise<SendChannels> {
  const creds = await loadMerchantCredentials(db, merchantId);
  return creds ? getChannelsFor(creds) : {};
}

/**
 * A Razorpay client on this merchant's account.
 *
 * Null when the merchant has no usable credentials, which the caller must treat
 * as "cannot create a payment link" rather than falling back to someone else's
 * account. Creating a link on the wrong merchant's account would take a real
 * customer to a real checkout billing the wrong business.
 */
export async function razorpayForMerchant(
  db: Database,
  merchantId: string,
): Promise<RazorpayClient | null> {
  const creds = await loadMerchantCredentials(db, merchantId);
  if (!creds?.razorpay) return null;
  return createRazorpayClient({
    keyId: creds.razorpay.keyId,
    keySecret: creds.razorpay.keySecret,
  });
}

export type { MerchantCredentials };
