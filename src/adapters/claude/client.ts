/**
 * The Claude client.
 *
 * Thin, like the Razorpay client: auth, timeouts, error classification, and the
 * structured-output round trip. No prompts and no business logic — those live in
 * the sibling files, one per job.
 *
 * ── the rule this file exists to enforce ──
 *
 * **A Claude failure is never allowed to fail the thing that called it.**
 *
 * Everything downstream of here is an enrichment: prose on an alert, a brief on
 * an escalation, a proposal for a human to review. Not one of them is load-
 * bearing. So this never throws — it returns a `Result`, and every caller has a
 * deterministic fallback it can ship instead. A model that is unreachable, rate
 * limited, or slow must degrade the output, never the recovery.
 *
 * That is also why the timeout is short and the retry count is low. This is
 * called from inside a ladder rung that is holding a workflow step open; waiting
 * a minute for better prose while a case sits still is the wrong trade.
 *
 * ── why structured output rather than free text ──
 *
 * Every call here returns JSON validated against a zod schema the caller owns.
 * Prose parsed with a regex is how a model's off-day becomes a malformed
 * database row. If the output does not validate, that is `invalid_output` and
 * the caller uses its fallback — the same path as the model being down.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';

import { env } from '../../lib/env.js';
import { type Result, err, ok } from '../../lib/result.js';

/**
 * The model.
 *
 * One constant, deliberately not per-call configurable. These jobs are all the
 * same shape — read a structured trace, return a small structured judgement —
 * and a mix of models across them would make the outputs incomparable for no
 * benefit.
 */
export const CLAUDE_MODEL = 'claude-opus-5';

export type ClaudeFailure =
  /** No ANTHROPIC_API_KEY. Expected on a fresh clone; not an error worth paging. */
  | 'not_configured'
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'transient'
  /** The model answered, but the answer did not match the schema. */
  | 'invalid_output'
  /** Safety refusal. Never retried — the same prompt refuses identically. */
  | 'refused'
  | 'unknown';

export interface ClaudeError {
  readonly failure: ClaudeFailure;
  readonly detail: string;
  /** False for anything a retry cannot fix. */
  readonly retryable: boolean;
}

export interface AskOptions<T> {
  /** Stable across calls of the same job — it is the cache prefix. */
  readonly system: string;
  /** The case, the cluster, the ledger slice. Volatile; goes last. */
  readonly user: string;
  /** JSON Schema handed to the API. Must be `type: 'object'`. */
  readonly schema: Record<string, unknown>;
  /** The same shape as a zod validator. The API is asked; this is believed. */
  readonly validator: z.ZodType<T>;
  /**
   * How hard to think. `medium` for prose, `high` for anything that classifies
   * or analyses — see the per-job files for which is which and why.
   */
  readonly effort?: 'low' | 'medium' | 'high';
  readonly maxTokens?: number;
  /** Hard ceiling on the whole call. Kept short; see the file header. */
  readonly timeoutMs?: number;
  /** Injected by tests. Production builds one from the environment. */
  readonly client?: Anthropic;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Generous for a few hundred tokens of JSON, because thinking counts too. */
const DEFAULT_MAX_TOKENS = 8_000;

/**
 * A sanity ceiling on any single string a job returns.
 *
 * Deliberately far above anything the prompts ask for. It exists to catch
 * runaway output, not to enforce a house style.
 *
 * ── why it is not tighter ──
 *
 * Structured outputs reject the JSON Schema validation vocabulary: `maxLength`,
 * `minLength`, `maxItems`, `minimum` and friends all come back as a 400. So a
 * length limit cannot be communicated to the model as a constraint — only asked
 * for in prose — and a tight `.max()` in zod does not shorten the answer, it
 * THROWS AWAY a good one.
 *
 * That is not hypothetical. The triage job asked for 1200 characters of
 * reasoning, the model wrote about 1400 of perfectly good reasoning, zod
 * rejected it, and the job reported a hard failure — for a limit that protects
 * nothing, since every column these land in is an unbounded `text`.
 *
 * Minimums are the real gate and stay tight: an empty `reasoning` field is
 * genuinely useless output. Where a value feeds a constrained slot — a list
 * title, a queue headline — the caller CLAMPS it. Never reject prose for being
 * long.
 */
export const MAX_FIELD = 4_000;

/** Trim a value to fit a display slot, on a word boundary where possible. */
export function clamp(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

let cached: Anthropic | null = null;

/**
 * The shared client, or null when no key is configured.
 *
 * Null rather than a throw: a fresh clone with no Anthropic key must still run
 * the whole test suite and the whole ladder. Every caller treats null as
 * `not_configured` and falls back.
 */
export function claudeClient(): Anthropic | null {
  if (cached) return cached;
  const key = env().ANTHROPIC_API_KEY;
  if (!key) return null;

  cached = new Anthropic({
    apiKey: key,
    // Two, not the default of two-plus-our-own: the SDK already retries 429s and
    // 5xx with backoff, and a ladder rung cannot afford a long ladder of retries
    // on top of that.
    maxRetries: 2,
  });
  return cached;
}

/** Tests only. */
export function resetClaudeClient(): void {
  cached = null;
}

/** Map an SDK exception onto something a caller can act on. */
function classify(error: unknown): ClaudeError {
  if (error instanceof Anthropic.AuthenticationError) {
    return { failure: 'auth', detail: error.message, retryable: false };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { failure: 'rate_limited', detail: error.message, retryable: true };
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return { failure: 'timeout', detail: error.message, retryable: true };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { failure: 'transient', detail: error.message, retryable: true };
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return {
      failure: status >= 500 ? 'transient' : 'unknown',
      detail: `${status}: ${error.message}`,
      retryable: status >= 500 || status === 408,
    };
  }
  return {
    failure: 'unknown',
    detail: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

/**
 * Ask Claude one question and get a validated answer.
 *
 * The whole surface. Every job in this directory is a system prompt, a rendered
 * context, and a schema — no job gets a tool, a loop, or a handle on anything
 * outside this function.
 */
export async function ask<T>(opts: AskOptions<T>): Promise<Result<T, ClaudeError>> {
  const client = opts.client ?? claudeClient();
  if (!client) {
    return err({
      failure: 'not_configured',
      detail: 'ANTHROPIC_API_KEY is not set — using the deterministic fallback.',
      retryable: false,
    });
  }

  let response;
  try {
    response = await client.messages.create(
      {
        model: CLAUDE_MODEL,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        // Adaptive rather than a fixed budget: these prompts vary a lot in how
        // much reasoning they deserve — a one-case brief is not a 400-event
        // ledger sweep — and the model is better placed to judge that per call
        // than a constant here is.
        thinking: { type: 'adaptive' },
        output_config: {
          effort: opts.effort ?? 'medium',
          format: { type: 'json_schema', schema: opts.schema },
        },
        // The system prompt is stable per job and the context is not, so the
        // cacheable prefix is exactly this boundary.
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
      },
      { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );
  } catch (error) {
    return err(classify(error));
  }

  // A safety refusal comes back as a normal 200. Checked before the content is
  // read, because `content` is empty or partial on a refusal and the schema
  // failure it would produce would name the wrong cause.
  if (response.stop_reason === 'refusal') {
    return err({
      failure: 'refused',
      detail: `refused (${response.stop_details?.category ?? 'unspecified'})`,
      retryable: false,
    });
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  if (text.trim().length === 0) {
    return err({
      failure: 'invalid_output',
      detail: `no text content (stop_reason: ${response.stop_reason})`,
      retryable: false,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err({
      failure: 'invalid_output',
      detail: `response was not JSON: ${text.slice(0, 200)}`,
      retryable: false,
    });
  }

  // Structured outputs make this very unlikely, and it is still checked. The
  // schema the API enforces and the schema the caller believes are two separate
  // artefacts, and the day they drift is the day an unvalidated field reaches a
  // database column.
  const validated = opts.validator.safeParse(parsed);
  if (!validated.success) {
    return err({
      failure: 'invalid_output',
      detail: validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      retryable: false,
    });
  }

  return ok(validated.data);
}
