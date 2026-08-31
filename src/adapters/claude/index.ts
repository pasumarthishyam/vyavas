/**
 * The Claude adapter.
 *
 * Four jobs, one client, and a rule that holds across all of them: the model
 * reads a structured trace and returns a small structured judgement that a
 * human or a deterministic guard consumes. It never chooses whether to contact
 * a customer, never sets a safety limit, and never mutates the taxonomy.
 *
 * Where Claude is deliberately ABSENT, and should stay absent:
 *
 *   compose.ts   the intent already determines the template, the language is a
 *                lookup, and every variable is a projection of the case. There
 *                is no judgement left to make, and WhatsApp templates are
 *                pre-approved by Meta anyway — improvised copy is unsendable.
 *   preconditions.ts  a safety limit is a comparison. A model that is right 99%
 *                of the time still double-messages someone once every hundred
 *                runs; `<` does not.
 *   diagnose.ts  43 documented codes with an exhaustive golden suite already
 *                beat a model, and they replay identically forever.
 */

export {
  CLAUDE_MODEL,
  type ClaudeError,
  type ClaudeFailure,
  ask,
  claudeClient,
  resetClaudeClient,
} from './client.js';

export { type AlertFacts, type AlertProse, fallbackProse, writeAlertProse } from './alert.js';

export {
  type Brief,
  type BriefFacts,
  type EscalationQueue,
  type LedgerEntry,
  fallbackBrief,
  writeBrief,
} from './brief.js';

export {
  type TriageFacts,
  type TriageProposal,
  type UnknownSample,
  triageUnknownReason,
} from './triage.js';

export {
  type AuditFacts,
  type AuditFinding,
  type AuditReport,
  type FailureBucket,
  auditLedger,
  fallbackReport,
} from './audit.js';
