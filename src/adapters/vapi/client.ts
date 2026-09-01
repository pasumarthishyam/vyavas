/**
 * The Vapi HTTP client.
 *
 * Thin, same shape as `adapters/razorpay/client.ts`: auth, retries, error
 * classification, nothing else. No business logic here — the guardrail, the
 * call-placing decision and the phone allow-list all live upstream of this.
 */

const BASE_URL = 'https://api.vapi.ai';

export class VapiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly body: unknown;

  constructor(opts: { message: string; status: number; retryable: boolean; body?: unknown }) {
    super(opts.message);
    this.name = 'VapiError';
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.body = opts.body ?? null;
  }
}

export interface VapiClientOptions {
  apiKey: string;
  baseUrl?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface VapiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function backoffMs(attempt: number): number {
  return 250 * attempt * attempt;
}

export function createVapiClient(opts: VapiClientOptions): VapiClient {
  const baseUrl = opts.baseUrl ?? BASE_URL;
  const maxAttempts = opts.maxAttempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const doFetch = opts.fetchImpl ?? fetch;

  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let lastError: VapiError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await doFetch(`${baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });

        const text = await res.text();
        const parsed: unknown = text.length > 0 ? safeJson(text) : null;

        if (res.ok) return parsed as T;

        const errBody = (parsed as { message?: string })?.message;
        lastError = new VapiError({
          message: `Vapi ${method} ${path} failed: ${res.status} ${errBody ?? text.slice(0, 200)}`,
          status: res.status,
          retryable: isRetryableStatus(res.status),
          body: parsed,
        });

        if (!lastError.retryable) throw lastError;
      } catch (e) {
        if (e instanceof VapiError) {
          if (!e.retryable) throw e;
          lastError = e;
        } else {
          lastError = new VapiError({
            message: `Vapi ${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
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

    throw lastError ?? new VapiError({ message: 'Unknown failure', status: 0, retryable: false });
  }

  function safeJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
  };
}

// ─── calls ───────────────────────────────────────────────────────────────────

export interface CreateCallInput {
  assistantId: string;
  phoneNumberId: string;
  /** E.164. Checked against the allow-list by the caller BEFORE this is called. */
  customerNumber: string;
  /** Surfaced back on every webhook for this call — carries our own case id. */
  metadata: Record<string, string>;
}

export interface VapiCall {
  id: string;
  status?: string;
  [key: string]: unknown;
}

export function createCall(client: VapiClient, input: CreateCallInput): Promise<VapiCall> {
  return client.post<VapiCall>('/call', {
    assistantId: input.assistantId,
    phoneNumberId: input.phoneNumberId,
    customer: { number: input.customerNumber },
    metadata: input.metadata,
  });
}

export function getCall(client: VapiClient, callId: string): Promise<VapiCall> {
  return client.get<VapiCall>(`/call/${callId}`);
}
