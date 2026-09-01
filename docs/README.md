# Vyavas — documentation

An AI revenue-recovery agent for Indian merchants on Razorpay. It detects
revenue at risk, diagnoses the root cause, and executes a bounded recovery
workflow.

This folder explains what the system does and why it is built the way it is.
The code is the source of truth; where a document and the code disagree, the
code is right and the document is a bug.

---

## Start here

| # | Document | Answers |
|---|---|---|
| 1 | [How it works](./01-how-it-works.md) | What happens between a failed payment and a recovered one |
| 2 | [Failure scenarios](./02-failure-scenarios.md) | All 44 failure reasons, the 9 classes, and what each one does |
| 3 | [Where the AI is](./03-ai.md) | What Claude does, what it is forbidden from doing, and why |
| 4 | [Safety and guarantees](./04-safety.md) | The invariants, and what enforces each one |
| 5 | [Operating it](./05-operations.md) | Commands, verification, and what to check when something looks wrong |

---

## The one idea

Failed payments, checkout drop-off, failed subscriptions and overdue
receivables look like four problems. They are one object:

> **A known customer, with known intent, owes a known amount, and something
> broke.**

That object is a `RecoveryCase`. The engine is built once; sources are added.

## The one rule

Most of the design follows from a single asymmetry:

> **A message we failed to send costs one order. A message sent to someone who
> already paid costs the relationship.**

That is why the order state is re-fetched from Razorpay before every single
customer touch rather than read from local state, why the gate distinguishes
*abort* from *defer*, why a policy may tighten a safety limit but never loosen
one, and why Claude is kept away from every decision about whether to contact
someone.

## Shape of the codebase

```
src/
├── core/        THE BRAIN. Pure — no I/O, no clock, no randomness.
├── db/          Drizzle + Postgres. 13 tables, 6 migrations.
├── adapters/    Razorpay, WhatsApp, email, Claude.
├── ingest/      normalize → diagnose → resolve → persist.
├── messaging/   Compose (pure) and send.
├── workflows/   Inngest orchestration. No business logic.
├── ops/         The human-in-the-loop jobs: escalations, alerts, triage, audit.
└── app/         Next.js dashboard, console, and webhook routes.
```

`src/core` may not import from `db`, `adapters`, `workflows` or `app`, and may
not call `new Date()`, `Date.now()` or `Math.random()`. This is enforced by
ESLint, not by convention. Two consequences, and they are the point:

1. **The brain is testable with zero infrastructure.** "9:04pm IST on a Sunday
   during an ICICI netbanking outage, third attempt, mandate present" is a table
   row, not a staging environment.
2. **Nothing built later can break what is built now.** Nothing downstream can
   import into core.
