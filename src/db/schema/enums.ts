/**
 * Postgres enums, derived from the core vocabularies.
 *
 * Declared from the `core` const arrays rather than retyped, so the database
 * and the brain cannot drift. Adding a case state in core and forgetting the
 * migration becomes a type error rather than a runtime insert failure.
 */

import { pgEnum } from 'drizzle-orm/pg-core';

import { CASE_STATES, CASE_TYPES, COHORTS, ERROR_SOURCES, ERROR_STEPS, PAYMENT_METHODS } from '../../core/case/types.js';
import { ACTION_KINDS, CHANNELS } from '../../core/actions/types.js';
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

export const downtimeSeverityEnum = pgEnum('downtime_severity', ['low', 'medium', 'high']);
