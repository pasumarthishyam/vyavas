/**
 * The Razorpay HTTP client.
 *
 * Thin on purpose. It handles auth, retries and error classification, and
 * nothing else — no business logic, no caching, no normalisation. Those belong
 * upstream where they can be tested without a network.
 *
 * The retry policy distinguishes what is worth retrying from what is not: a 429
 * or a 5xx is transient, a 400 or a 404 will fail identically forever, and
 * retrying it just burns the rate limit we will need during an actual outage.
 */

import { requireRazorpayCredentials } from '../../lib/env.js';

const BASE_URL = 'https://api.razorpay.com/v1';

export class RazorpayError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;
  readonly body: unknown;

  constructor(opts: {
    message: string;
    status: number;
    code?: string | null;
    retryable: boolean;
    body?: unknown;
  }) {
    super(opts.message);
    this.name = 'RazorpayError';
    this.status = opts.status;
    this.code = opts.code ?? null;
    this.retryable = opts.retryable;
    this.body = opts.body ?? null;
  }
}

export interface RazorpayClientOptions {
  keyId?: string;
  keySecret?: string;
  baseUrl?: string;
  /** Total attempts including the first. */
  maxAttempts?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface RazorpayClient {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

/** 429 and 5xx are worth retrying. 4xx will fail the same way forever. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function backoffMs(attempt: number): number {
  // 250ms, 1s, 2.25s … deterministic, so a test can assert the schedule.
  return 250 * attempt * attempt;
}

export function createRazorpayClient(opts: RazorpayClientOptions = {}): RazorpayClient {
  const creds =
    opts.keyId && opts.keySecret
      ? { keyId: opts.keyId, keySecret: opts.keySecret }
      : requireRazorpayCredentials();

  const baseUrl = opts.baseUrl ?? BASE_URL;
  const maxAttempts = opts.maxAttempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const doFetch = opts.fetchImpl ?? fetch;

  const auth = `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64')}`;

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    init: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    let lastError: RazorpayError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await doFetch(url.toString(), {
          method,
          headers: {
            Authorization: auth,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: controller.signal,
        });

        const text = await res.text();
        const parsed: unknown = text.length > 0 ? safeJson(text) : null;

        if (res.ok) return parsed as T;

        const errBody = (parsed as { error?: { code?: string; description?: string } })?.error;
        lastError = new RazorpayError({
          message: `Razorpay ${method} ${path} failed: ${res.status} ${errBody?.description ?? text.slice(0, 200)}`,
          status: res.status,
          code: errBody?.code ?? null,
          retryable: isRetryableStatus(res.status),
          body: parsed,
        });

        if (!lastError.retryable) throw lastError;
      } catch (e) {
        if (e instanceof RazorpayError) {
          if (!e.retryable) throw e;
          lastError = e;
        } else {
          // Network failure or timeout — always worth another attempt.
          lastError = new RazorpayError({
            message: `Razorpay ${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
            status: 0,
            retryable: true,
          });
        }
      } finally {
        clearTimeout(timer);
      }

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      }
    }

    throw lastError ?? new RazorpayError({ message: 'Unknown failure', status: 0, retryable: false });
  }

  function safeJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
  };
}
