# Vyavas

An AI revenue-recovery agent for merchants and platforms on **Razorpay**.

It detects revenue at risk, diagnoses the root cause, and executes a bounded
recovery workflow — across payment failures, checkout drop-off, failed
subscriptions and overdue receivables.

---

## Documentation

Full docs live in [`docs/`](./docs/README.md). This README is the build-and-run
reference; the docs explain the design.

| Document | Answers |
|---|---|
| [How it works](./docs/01-how-it-works.md) | What happens between a failed payment and a recovered one |
| [Failure scenarios](./docs/02-failure-scenarios.md) | All 44 failure reasons, the 9 classes, and what each one does |
| [Where the AI is](./docs/03-ai.md) | What Claude does, what it is forbidden from doing, and why |
| [Safety and guarantees](./docs/04-safety.md) | The invariants, and what enforces each one |
| [Operating it](./docs/05-operations.md) | Commands, verification, and what to check when something looks wrong |

---

## The one idea

Those four problems look like four products. They are one object:

> **a known customer, with known intent, owes a known amount, and something broke.**

That object is a `RecoveryCase`. Build the engine once; add sources.

---

## Architecture

```
src/
├── core/        ◄── THE BRAIN.  Pure. No I/O, no clock, no randomness.
├── db/              Drizzle + Supabase (Postgres, ap-south-1)      [Stage 3]
├── adapters/        Razorpay, WhatsApp, SMS, email, Claude         [Stage 4]
├── workflows/       Inngest orchestration — no business logic      [Stage 6]
├── app/             Next.js dashboard + webhook routes             [Stage 5]
└── lib/             Result type, env, logging
```

### The boundary rule

`src/core` may not import from `db`, `adapters`, `workflows` or `app`. It may
not call `new Date()`, `Date.now()` or `Math.random()`. Every function takes
what it needs as an argument and returns a decision.

This is enforced by ESLint (`eslint.config.mjs`), not by convention. Two
consequences, and they are the point:

1. **The brain is testable with zero infrastructure.** "9:04pm IST on a Sunday
   during an ICICI netbanking outage, third attempt, mandate present" is a
   table row, not a staging environment.
2. **Nothing built later can break what is built now.** Nothing downstream can
   import into core, so Stage 1 stays finished as Stages 3–8 land.

---

## Status

| Stage | Module | State |
|-------|--------|-------|
| 0 | Spine — money, case types, state machine, action allowlist | ✅ done |
| 1 | Taxonomy & Diagnose — all 43 Razorpay codes | ✅ done |
| 2 | Policy engine — versioned ladder table + resolver | ✅ done |
| 3 | Persistence — Drizzle schema, advisory locks, webhook dedupe | ✅ done |
| 4 | Razorpay adapter + Ingest | ✅ done |
| 5 | Read-only Revenue-at-Risk dashboard → **ship to partners** | ✅ done |
| 6 | Execute (Inngest), bounded | ✅ done |
| 7 | Channels — WhatsApp + email, live | ✅ done |
| 8 | Claude — escalation queue, merchant alerts, triage, self-audit | ✅ done |
| 9 | Measure + Partner OAuth | next |

---

## Commands

```bash
npm run verify        # policy:check + typecheck + lint + test — the gate for every stage
npm run typecheck
npm run lint
npm test
npm run test:watch
npm run test:coverage

npm run policy:build  # regenerate generated.ts after editing any policy YAML
npm run policy:check  # fail if the committed artefact is stale

npm run db:generate   # new migration from the Drizzle schema
npm run db:migrate    # apply migrations (uses DIRECT_DATABASE_URL, port 5432)
npm run db:studio     # browse the database
npm run test:integration  # concurrency proofs — needs TEST_DATABASE_URL

npm run dev           # the dashboard, http://localhost:3000
npm run build         # production build
npm run seed:demo -- --reset   # realistic demo data through the real pipeline
npm run fixtures:capture       # pull real failure payloads from Razorpay test mode

npm run dev:inngest            # local Inngest dev server (run alongside npm run dev)
npm run replay                 # what the CURRENT policy table would do to real cases
npm run replay -- --case=<id>  # one case, rung by rung, with the gate reasoning
npm run dry-run:report         # what would have been sent, and what the gate stopped

npm run templates:status       # Meta review status for the 9 templates
npm run templates:submit       # create any that are missing
npm run send:test -- --to=91XXXXXXXXXX   # one real message, end to end

npm run user -- create --email you@example.com --password '…'   # the FIRST account
npm run user -- list
npm run user -- password --email you@example.com --password '…' # signs out everywhere
npm run user -- grant  --email you@example.com --slug <merchant>
npm run user -- revoke --email you@example.com --slug <merchant>

# Scripts that take flags are run with npx, NOT `npm run` — see the note below.
npx tsx scripts/merchant.ts list
npx tsx scripts/merchant.ts mode --slug <merchant> --set paused   # park cases
npx tsx scripts/merchant.ts mode --slug <merchant> --set live

npx tsx scripts/simulate.ts --list                        # the failure scenarios
npx tsx scripts/simulate.ts --slug sandbox --scenario card_expired
npx tsx scripts/simulate.ts --slug sandbox --order <orderId> --paid

npm run queue                  # the escalation queue — cases waiting on a person
npm run queue -- --escalate=<caseId>     # queue a real case NOW, with a real brief
npm run queue -- --ack=<id> --by=<name>
npm run queue -- --resolve=<id> --note="…"
npm run audit                  # which cases we lost WITHOUT ever acting, and why
npm run audit -- --days=30 --no-ai
npm run triage                 # propose cause classes for unknown failure reasons
npm run triage -- --list       # pending proposals; none is ever auto-applied
npm run ai:smoke               # call all four Claude jobs for real — run after any schema edit
```

### Verifying the AI is actually working

Failing soft is the right behaviour and it makes a dead integration look exactly
like a quiet one. Three ways to tell them apart, cheapest first:

1. **The console.** `/recovery` → the **Needs a person** panel. Every brief
   carries a badge: `Claude · high` when the model wrote it, `Fallback` when it
   did not — hover for the reason. The panel header shows the running count
   (`AI on · 4 written, 1 fell back`) and turns red if every brief has fallen
   back. The case table gets a **Needs a person** filter for the same set.
2. **End to end, on a real case.** `npm run queue -- --escalate=<caseId>` reads
   that case's real ledger, asks Claude for a brief, and writes the queue row —
   the exact path a policy rung takes, minus the waiting. It prints whether the
   brief came from the model or the fallback. Nobody is contacted; dismiss the
   row afterwards.
3. **All four jobs.** `npm run ai:smoke`.

`ai:smoke` exists because every Claude job is designed to **fail soft**, and a
job that fails soft hides a broken request. `output_config.format.schema` accepts
only the structural half of JSON Schema — `maxItems`, `maxLength` and `minimum`
are all 400s — and TypeScript, zod and the unit tests all say yes to a schema
the API rejects. In production that 400 becomes a fallback, and the fallback
looks exactly like "no API key set". One live run is the only thing that tells
them apart. A unit test guards the schemas offline; this proves the round trip.

### Signing in

The console is behind authentication. Two things are needed before anyone can
open it, and the order matters:

```bash
# 1. A signing secret, in .env.local AND in the deployment environment.
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# 2. The account. There is no sign-up page anywhere in the app — a public URL
#    with a sign-up form is a public URL anyone can get an account on.
npm run user -- create --email you@example.com --password '…' --name 'Your Name'
```

`create` maps **every existing merchant** to the new account, because a
deployment that has been running without a login belongs to whoever is creating
the first account. Pass `--no-claim` for later users and `grant` them one
account at a time.

**Without `SESSION_SECRET` the app refuses every request** rather than letting
them through. A missing secret means no token can be verified, and the safe
reading of that is "nobody is signed in", never "everybody is".

`src/middleware.ts` is the gate, and **its location is part of the feature**.
This project has a `src` directory, so Next.js looks for middleware beside
`app/`. A middleware at the repository root is silently ignored — no error, no
warning, `next build` succeeds and every page serves to anyone. The tell is the
absence of a `Middleware` line in the build output:

```bash
npm run build | grep Middleware
# ƒ Middleware    33.1 kB     <- registered
# (nothing)                   <- NOT registered; the app is wide open
```

Public paths are listed explicitly in that file: the Razorpay, WhatsApp, Vapi
and abandoned-cart webhooks, the Inngest endpoint, and `/api/health`. Each has
its own authentication. Everything else needs a session, and a new page added
later is protected by default.

### Running it locally, so ladders actually run

Two environment facts, and without either one no rung ever fires. Both fail
quietly in a way that looks like the gate deferring rather than a broken setup.

```bash
INNGEST_DEV=1 npm run dev        # terminal 1
npm run dev:inngest              # terminal 2 — point -u at your dev port
```

**`INNGEST_DEV=1` is required.** The SDK defaults to cloud mode and refuses to
serve without a signing key, so `/api/inngest` answers 500 and no function is
ever invoked. Check it with `curl localhost:3000/api/inngest` — you want
`"mode":"dev"` and a non-zero `function_count`.

**`APP_URL` must not be the production host while developing.** The Inngest
route pins its callback origin to `APP_URL` for a real production reason (the
Vercel apex→www redirect), and that pin is now disabled in dev — without that
fix a local dev server registered `https://www.vyavas.com/api/inngest`, so every
locally triggered run executed against the LIVE SITE and came back 401. The
local Next log showed nothing at all, because nothing ever reached it.

**Never run `npm run build` while `npm run dev` is up.** They share `.next`, and
the build rewrites the chunk files under the running dev server. The result is a
burst of `MODULE_NOT_FOUND` on `_document.js` and `./vendor-chunks/*.js` plus
`Cannot read properties of undefined (reading '/_app')`, and every page 500s.
Nothing is corrupted permanently:

```bash
# stop the dev server first, then
rm -rf .next && npm run dev
```

### Where a real Razorpay webhook actually goes

**Razorpay cannot reach your laptop.** Every delivery goes to the URL configured
in the Razorpay dashboard, which is the deployed site. So paying a test link
while `npm run dev` is running does not touch your dev server at all: the event
lands on production, and production is the code that decides what happens to it.

That has one consequence worth internalising, because it looks exactly like a
bug in the thing you are working on:

> A fix that is not deployed does not exist, however green your local tests are.
> The payment arrives, production handles it with the old code, and your local
> console shows nothing — because both are reading the same database and only
> one of them ran.

Three ways to work with that:

- **`npx tsx scripts/simulate.ts --url http://localhost:3000`** posts a properly
  signed payload straight at your dev server. No tunnel, no dashboard change.
- **A tunnel** (`cloudflared tunnel --url http://localhost:3000`) with the
  Razorpay TEST-mode webhook pointed at it, when you want the real thing.
- **Deploy**, and test against production with the Sandbox merchant.

### When a delivery gets stranded

The webhook endpoint CLAIMS a delivery before processing it, which is what makes
an at-least-once delivery safe to receive twice. The cost is that a claim
outlives the process that made it: if the function dies between the claim and
the "processed" mark, the row sits marked as seen, dedupe turns Razorpay's own
retry into a no-op, and the event is lost silently — with no error recorded,
because whatever would have recorded one died too.

`sweep-deadlines` redrives every fifteen minutes in production. On demand:

```bash
npx tsx scripts/redrive.ts --dry     # what is stuck
npx tsx scripts/redrive.ts           # reprocess it
npx tsx scripts/redrive.ts --publish # ...and restart ladders for failures
```

`--publish` is off by default because reprocessing a `payment.failed` starts a
ladder, and a terminal is the wrong place to do that by accident. Success events
(`order.paid`, `payment_link.paid`) only ever close cases, so clearing a backlog
of those needs no publisher.

### Testing it, with no real failures to work from

You cannot test a recovery agent without a failed payment, and Razorpay will not
fail one on request. Test mode gives you declining cards, but driving a checkout
by hand for every scenario is slow, and several of the interesting cases (a bank
outage, a risk decline, a third wrong OTP) cannot be produced from a card number
at all.

```bash
npx tsx scripts/simulate.ts --slug sandbox --scenario card_expired
```

**Use `npx tsx`, not `npm run`, for anything that takes flags.** On PowerShell
npm claims `--slug` as one of its own boolean options, sets `npm_config_slug=true`
and passes the bare value through as a positional — so the script reads `true`
as the merchant name and reports `No merchant 'true'`. Both scripts now detect
that and print the working command, but the direct form always works.

That signs a real Razorpay-shaped payload with the merchant's **own** stored
webhook secret and POSTs it to the merchant's **own** endpoint. Nothing is
stubbed and nothing is bypassed: the signature is verified, the delivery is
claimed and deduped, the tuple is normalised, `diagnose()` runs, a policy row is
stamped, the case is created and the ladder is published. It is the path a live
delivery takes, because it is that path.

Two rails on it. It **refuses a merchant connected in live mode**, because a
fabricated failure on a live account creates a real case about a customer whose
payment never failed, and the agent will then message them. And it never writes
to the database directly — a script that inserted cases would prove the console
renders and nothing else.

The full loop:

```bash
npx tsx scripts/simulate.ts --list                                   # every scenario
npx tsx scripts/simulate.ts --slug sandbox --scenario incorrect_otp  # make a case
npx tsx scripts/simulate.ts --slug sandbox --order <orderId> --paid  # close it
npx tsx scripts/simulate.ts --slug sandbox --link-paid --reference <caseId>
```

Then watch `/recovery`: the case appears with its cause class and the ladder it
was stamped with, the rungs fire, and closing it moves the **Recovered** tile.
`--link-paid` is the one worth exercising deliberately, because paying a recovery
link is the outcome the whole product exists to produce and the path most likely
to regress.

Two things to know before the first run:

- **Locally, the ladder needs Inngest.** Publishing fails without
  `INNGEST_EVENT_KEY`, so the case is created and diagnosed but no rung ever
  fires. Run `npm run dev:inngest` alongside `npm run dev`, or point `--url` at
  the deployment. The webhook reports the publish failure honestly rather than
  swallowing it, and the redrive sweep retries.
- **Holdout is on by default at 5%.** Roughly one simulated case in twenty will
  deliberately send nothing and be marked `holdout`. If a case sits there having
  done nothing, check that first. Set `holdout_basis_points` to 0 on a test
  account.

### Database setup

Supabase project `jxiimmdduhhhtxnbemih`, region `ap-south-1` (Mumbai).
Live on Postgres 17.6: 11 tables, 16 enums, 43 indexes (11 partial).

Copy `.env.example` to `.env.local`, fill in the connection strings from the
Supabase dashboard, then:

```bash
npm run db:migrate    # apply the schema
npm run db:doctor     # assert the guarantees are actually present
```

`db:doctor` exists because "migrations applied successfully" is not the same as
the constraints being there. A partial index silently omitted still lets every
INSERT through, and the first symptom would be a customer receiving two recovery
ladders for one order. It checks each guarantee by name and prints what breaks in
the real world if one is missing.

**`db:migrate` prints two `NOTICE` blocks on every run after the first, and they
are not errors:**

```
code: '42P06', message: 'schema "drizzle" already exists, skipping'
code: '42P07', message: 'relation "__drizzle_migrations" already exists, skipping'
```

That is drizzle-kit creating its own bookkeeping schema with `IF NOT EXISTS`, and
postgres.js printing the server's notice as a raw object. `severity: 'NOTICE'` is
the tell — a real failure raises `severity: 'ERROR'` and a non-zero exit code.
The command is also quiet on success, so an apparently empty finish is the
expected one. `db:doctor` is how you confirm it actually worked.

**Credentials live in `.env.local`, which is gitignored.** `.env.example` is the
committed template and must never contain a real password.

Two things that are not optional:

- **The app uses the POOLED string (port 6543); migrations use the DIRECT one
  (5432).** Supavisor's transaction mode cannot hold the session state DDL and
  advisory locks need.
- **`prepare: false`** in `db/client.ts`. Supavisor multiplexes clients onto few
  backends, so a prepared statement created on one invocation may not exist on
  the backend the next one lands on. Leaving it on produces intermittent
  failures that only appear under concurrency — during a merchant's outage,
  when it matters most.
- **Session mode caps concurrent clients at 15** on the default plan, and
  exceeding it is a FATAL `EMAXCONNSESSION` rather than a queue. That is the
  hard argument for transaction mode with `max: 1` per invocation in production:
  session mode simply does not have the client slots for a serverless fan-out.

`npm run verify` must be green before a stage is considered done.

---

## What is built (Stages 0–1)

**Money** (`core/money.ts`) — integer paise with a branded type, so
`amount + 0.5` is a compile error. Indian lakh/crore formatting. `shareOf()` in
basis points for commission on recovered revenue.

**Case model** (`core/case/`) — the four case types, the seven states, a
transition table where terminal is genuinely terminal, and intent-decay
deadlines.

**Action allowlist** (`core/actions/types.ts`) — the complete vocabulary of
things the agent may do. The planner emits a value of this union and nothing
else; it never gets a generic handle on the Razorpay API. Bounded autonomy as a
type, not as a prompt.

**Taxonomy** (`core/taxonomy/`) — all 43 documented Razorpay failure reasons
across the general, card and gateway lists, mapped to nine cause classes, with
the disambiguation rules that make `(code, source, step, reason, method)` the
routing key rather than `reason` alone.

**Diagnose** (`core/taxonomy/diagnose.ts`) — tuple + context → what is wrong and
how we may behave. Applies the live downtime override, tightens on attempt
history before an instrument gets locked, and decides attended vs unattended.

**Cohort** (`core/cohort.ts`) — deterministic holdout assignment, stable under
rate changes so historical incrementality numbers stay valid.

**Policy engine** (`core/policy/`) — 27 versioned ladder rows authored as YAML,
one file per cause class, compiled to a frozen table with a weighted
most-specific-wins resolver. `compile.ts` is where the real work is: it refuses
any table that could instruct the agent to do something indefensible — a ladder
exceeding its cause class's touch ceiling, a nudge landing before the class
floor, `retry_same` on an instrument that can never work, a debit on an
attended case or without RBI pre-debit notice, a customer-facing row that does
not abort on `order_paid`, or two rows whose winner depends on declaration order.

The governing rule: **a policy may tighten a safety limit, never loosen one.**
Cause-class traits are the ceiling; policy rows live under them.

`effectiveRails()` is the runtime counterpart — where the static table and the
live diagnosis disagree, the diagnosis wins and may only ever remove rails. A
policy can never re-authorise something the diagnosis has ruled out.

**Persistence** (`src/db/`) — 11 tables, one migration, driver-agnostic repos.
The guarantees that matter are enforced by Postgres, not by application care:

| Guarantee | Mechanism |
|---|---|
| Only signed-in people reach the console | HMAC-verified session cookie, checked in middleware |
| A user only ever sees their own merchants | `merchant_members` join on every merchant lookup |
| A paid recovery link closes its case | `payment_link.paid` resolved by `reference_id` |
| One live case per order | partial unique index on live states |
| A replayed rung never fires twice | unique `idempotency_key` on actions and messages |
| A retried webhook is a no-op | `ON CONFLICT DO NOTHING … RETURNING` on the event id |
| A customer is never messaged twice at once | `pg_advisory_xact_lock` keyed on the person |
| The cap is global per person, not per case | `message_log` keyed on `customer_id` |
| Holdouts don't eat the treatment budget | partial index excluding suppressed rows |
| One open alert per condition | partial unique index on unresolved alerts |
| A new merchant sends nothing | `execution_enabled: false` by default, which means PAUSED |

**Razorpay adapter** (`src/adapters/razorpay/`) — HMAC-SHA256 webhook
verification over the raw bytes, an HTTP client that distinguishes retryable
(429/5xx/timeout) from permanent (4xx) failures, and the resource calls. The
one that matters most is `isOrderPaid`, the precondition re-checked before every
customer touch — it asks Razorpay rather than trusting local state, and treats
an API failure as "paid", because a message we failed to send costs one order
while a message to someone who already paid costs the relationship.

**Ingest** (`src/ingest/`) — `normalize → diagnose → resolve → persist`, as a
plain function over a `Database`. Deliberately not a Next.js route: the whole
contract is testable without a server, and the HTTP layer is five lines of
wrapper. The webhook entry point verifies, claims the delivery, hands off, and
returns 200 — always 200 once a delivery is accepted, because a 500 makes
Razorpay resend an event we already claimed, the dedupe swallows the resend, and
the event is lost. The redrive sweep recovers failures, not Razorpay's retry.

**Dashboard** (`src/app/`) — Next.js on Vercel. Read-only: it never writes to a
case and never sends anything. Three views — the Revenue-at-Risk overview, a
filterable case list, and a case detail that shows the raw tuple, the diagnosis
rationale in plain language, and **the ladder that would run**. That last part is
what makes this shippable on its own: a merchant sees exactly what the agent
would say, to whom, and when, before granting write access to anything.

Design decisions worth knowing:

- **No chart library and no CSS framework.** Inline SVG and hand-written CSS with
  design tokens. Full control over the marks, nothing to load.
- **Cause classes and banks get ONE hue.** Darkening a bar by its own value would
  double-encode length as colour and burn the only free channel on information
  the bar already shows. The heatmap is the one legitimate exception — a grid of
  continuous magnitude is exactly what a sequential ramp is for.
- **Status colour never carries meaning alone.** Two of the four status steps sit
  below 3:1 on the light surface by design, so every one is paired with an icon
  and a word.
- **Money is masked at the query layer, not the template.** A support screenshot
  should never carry a full phone number, and relying on each view to remember
  that is how one eventually does not.

```bash
npm run seed:demo -- --reset   # 320 cases through the REAL pipeline
npm run dev                    # http://localhost:3000
```

The seed calls `processEvent` — the same function the webhook route calls — so
the dashboard shows data the system genuinely produced, and seeding doubles as
an end-to-end smoke test against the live database.

The database tests run against **PGlite** — real Postgres compiled to WASM,
in-process — so `npm test` exercises partial unique indexes, `ON CONFLICT`,
native enums and advisory locks with no external database to start. PGlite is
single-connection, so the contention proofs live in
`tests/db/concurrency.integration.test.ts` and run against a real Postgres when
`TEST_DATABASE_URL` is set.

### The tests that matter

- `tests/golden/fixtures.ts` — one fixture per error code, plus scenarios for
  downtime, attempt history and mandates.
- `tests/golden/exhaustiveness.test.ts` — **fails CI if any code lacks a
  fixture**, if two rules tie ambiguously, or if any reachable tuple produces an
  inconsistent diagnosis. It brute-forces the entire
  reason × source × step × method space.

That second file is what makes Stage 1 *finished* rather than merely written. It
is the thing standing between this taxonomy and the fate of every dunning tool
on the market: a dozen codes handled properly and a generic email for everything
else.

---

## Where Claude is, and where it is not (Stage 8)

Four jobs, one adapter (`src/adapters/claude/`), and one rule that holds across
all of them:

> **Claude reads a structured trace and returns a small structured judgement
> that a human or a deterministic guard consumes. It never chooses whether to
> contact a customer, never sets a safety limit, and never mutates the taxonomy.**

| Job | Input | Output lands in | If the model is down |
|---|---|---|---|
| Merchant alert prose | A counted cluster of failing cases | `merchant_alerts` | Deterministic title + facts |
| Escalation brief | One case's tuple, rationale and ledger | `escalations` | A brief naming cause, money, activity |
| Unknown-reason triage | Sampled tuples for a reason we do not know | `taxonomy_proposals` (pending) | The job reports it could not run |
| Ledger self-audit | Failure buckets counted in SQL | A terminal report | Buckets ranked by money |

Four things make this safe rather than decorative:

- **Nothing is load-bearing.** `ANTHROPIC_API_KEY` is optional. Every job has a
  deterministic fallback that is a supported path, not a stub, and `ask()`
  returns a `Result` rather than throwing — a failure downgrades the prose, never
  the recovery. `briefSource` and the alert detail record which one you got, so
  a week of nothing but fallbacks is discoverable rather than merely disappointing.
- **The model never counts.** Every number in an alert or an audit finding is a
  SQL aggregate computed before the call and passed in as fact. The prompts
  forbid introducing a figure that is not in the input. A model that invents
  "roughly 50 cases" in an alert a merchant acts on is worse than no alert, and
  the fix is not a better prompt — it is not asking it to count.
- **Severity is the policy's.** Whether a condition is `warning` or `critical`
  decides whether someone is woken at 2am. That lives in a reviewed YAML table,
  not in a paragraph generator's judgement on the night.
- **Every output is validated twice** — the API enforces a JSON schema, and the
  caller re-validates with zod. Output that does not match is `invalid_output`
  and takes the fallback path, the same as the model being unreachable.

**The taxonomy boundary is absolute.** There is deliberately no code path from
an accepted `taxonomy_proposals` row to a change in `codes.ts` or
`diagnose.ts`. Accepting a proposal means a person opens an editor and writes
the rule by hand, with a golden fixture, like every other entry. The taxonomy is
the safety ceiling for the whole agent — `sameInstrumentRetry` and
`contactCustomer` are derived from the cause class — so a wrong class there does
not produce a badly worded message, it produces a customer's card locked at the
issuer after a third automated retry.

### Where Claude is deliberately absent

- **`compose.ts`** — the intent already determines the template, the language is
  a lookup, and every variable is a projection of the case. There is no judgement
  left to make, and WhatsApp templates are pre-approved by Meta anyway, so
  improvised copy is unsendable.
- **`preconditions.ts`** — a safety limit is a comparison. A model that is right
  99% of the time still double-messages someone once every hundred runs; `<` does
  not.
- **`diagnose.ts`** — 44 documented codes with an exhaustive golden suite already
  beat a model, and they replay identically forever.

### What Stage 8 fixed that was not about AI at all

Two of these were dead ends in the code long before a model was involved, and
the queue matters more than the prose in it:

- `escalate_to_human` built an action, wrote a `case_actions` row, and stopped.
  No queue, no notification, no UI, and a static note copied from the YAML — so
  `risk.payment_risk_check_failed` escalated to `risk_review` and nobody was ever
  told. `escalations` is that queue; `npm run queue` is how you read it.
- `merchant_alert` fired with `signal: 'ladder'` and `amountAtRisk: 0`. The
  `merchant_alerts` table had existed since Stage 3 and the dashboard had read it
  since Stage 5; nothing ever wrote a row. It now fires on a counted **cluster**,
  because one case failing is a case, not a breakage.

The self-audit exists for a failure mode this codebase has already had once: a
case whose frequency cap cleared three hours out, deferred twice against a flat
one-hour guess, and abandoned 57 minutes early having sent nothing — "no trace
except four `rung_deferred` rows that all say the same thing" (`run-ladder.ts`).
That was found by hand. `npm run audit` is that reading, weekly.

---

## Non-negotiables

- **Money is integer paise.** Never a float. Anywhere.
- **`attended` is decided explicitly on every case.** Under RBI rules there is
  no lawful silent card retry in India without a mandate. Getting this wrong is
  a compliance incident, not a bug.
- **`order_already_paid` closes the case and cancels everything queued.**
  Messaging a customer who has already paid is the one mistake that ends the
  relationship.
- **A deliberate exit is never dressed as a failure.** `payment_cancelled` is a
  live intent signal; it gets its own case type and never sees failure language.
- **Risk declines get one touch on one alternate rail.** Re-presenting raises
  the risk score and degrades the merchant's authorisation rate.
- **Merchant-fault classes alert the merchant with facts, not prescriptions.**
  Turning off a payment method is their commercial decision, not ours.
