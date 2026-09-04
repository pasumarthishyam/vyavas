/**
 * Postgres enums, derived from the core vocabularies.
 *
 * Declared from the `core` const arrays rather than retyped, so the database
 * and the brain cannot drift. Adding a case state in core and forgetting the
 * migration becomes a type error rather than a runtime insert failure.
 */

import { pgEnum } from 'drizzle-orm/pg-core';

import { CASE_STATES, CASE_TYPES, COHORTS, ERROR_SOURCES, ERROR_STEPS, PAYMENT_METHODS } from '../../core/case/types.js';
import { ACTION_KINDS, CHANNELS, ESCALATION_QUEUES } from '../../core/actions/types.js';
import { CAUSE_CLASSES } from '../../core/taxonomy/cause-class.js';

/** pgEnum wants a mutable non-empty tuple; core exports readonly consts. */
const tuple = <T extends string>(values: readonly T[]) => values as unknown as [T, ...T[]];

export const caseTypeEnum = pgEnum('case_type', tuple(CASE_TYPES));
export const caseStateEnum = pgEnum('case_state', tuple(CASE_STATES));
export const cohortEnum = pgEnum('cohort', tuple(COHORTS));
export const causeClassEnum = pgEnum('cause_class', tuple(CAUSE_CLASSES));
export const paymentMethodEnum = pgEnum('payment_method', tuple(PAYMENT_METHODS));
export const errorSourceEnum = pgEnum('error_source', tuple(ERROR_SOURCES));
export const errorStepEnum = pgEnum('error_step', tuple(ERROR_STEPS));
export const channelEnum = pgEnum('channel', tuple(CHANNELS));
export const actionKindEnum = pgEnum('action_kind', tuple(ACTION_KINDS));

export const connectionModeEnum = pgEnum('connection_mode', ['test', 'live']);
export const connectionStatusEnum = pgEnum('connection_status', [
  'active',
  'revoked',
  'error',
]);

/** Read-only until the merchant explicitly upgrades. Land read-only, then expand. */
export const connectionScopeEnum = pgEnum('connection_scope', ['read_only', 'read_write']);

export const actionStatusEnum = pgEnum('action_status', [
  'planned',
  'skipped',
  'executed',
  'failed',
  'suppressed',
]);

export const messageStatusEnum = pgEnum('message_status', [
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'suppressed',
]);

export const alertSeverityEnum = pgEnum('alert_severity', ['info', 'warning', 'critical']);

export const escalationQueueEnum = pgEnum('escalation_queue', tuple(ESCALATION_QUEUES));

/**
 * `dismissed` is separate from `resolved` on purpose: "a person looked and
 * decided there was nothing to do" and "a person fixed it" are different
 * outcomes, and collapsing them would hide a queue that is mostly noise.
 */
export const escalationStatusEnum = pgEnum('escalation_status', [
  'open',
  'acknowledged',
  'resolved',
  'dismissed',
]);

export const proposalStatusEnum = pgEnum('proposal_status', ['pending', 'accepted', 'rejected']);

export const downtimeSeverityEnum = pgEnum('downtime_severity', ['low', 'medium', 'high']);

export const voiceCallStatusEnum = pgEnum('voice_call_status', [
  'queued',
  'ringing',
  'in_progress',
  'ended',
  'failed',
]);

/**
 * `suppressed` is not a failure and not a success.
 *
 * It is a cart this agent deliberately declined to act on because the same
 * customer already has a payment failure being recovered — see
 * `core/guards/cart-suppression.ts`. Folding it into `failed` would put a
 * correct decision in the same bucket as a broken Razorpay call, and hide the
 * single most useful number this agent has: how often the merchant's app
 * reports a "cart" that is really a decline.
 */
export const abandonedCartStatusEnum = pgEnum('abandoned_cart_status', [
  'detected',
  'emailed',
  'recovered',
  'expired',
  'failed',
  'suppressed',
]);
