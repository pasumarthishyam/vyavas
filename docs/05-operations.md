# Operating it

Commands, the console, and what to check when something looks wrong.

---

## The gate

```bash
npm run verify      # policy:check + typecheck + lint + test
```

Must be green before a change ships. Everything below assumes it is.

```bash
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run test:integration   # concurrency proofs — needs TEST_DATABASE_URL
```

Database tests run against **PGlite** — real Postgres compiled to WASM,
in-process — so `npm test` exercises partial unique indexes, `ON CONFLICT`,
native enums and advisory locks with no external database. PGlite is
single-connection, so contention proofs live in the integration suite and need a
real Postgres.

---

## Database

```bash
npm run db:generate    # new migration from the Drizzle schema
npm run db:migrate     # apply migrations (uses DIRECT_DATABASE_URL, port 5432)
npm run db:doctor      # assert the guarantees are actually present
npm run db:studio
```

Two things that are not optional:

- **The app uses the POOLED connection string (port 6543); migrations use the
  DIRECT one (5432).** Supavisor's transaction mode cannot hold the session state
  DDL and advisory locks need.
- **`prepare: false`** in `db/client.ts`. Supavisor multiplexes clients onto few
  backends, so a prepared statement created on one invocation may not exist on
  the backend the next one lands on.

> **`db:migrate` prints two `NOTICE` blocks after the first run. They are not
> errors.**
>
> ```
> code: '42P06', message: 'schema "drizzle" already exists, skipping'
> code: '42P07', message: 'relation "__drizzle_migrations" already exists, skipping'
> ```
>
> That is drizzle-kit creating its own bookkeeping schema with `IF NOT EXISTS`,
> and postgres.js printing the server's notice as a raw object. `severity:
> 'NOTICE'` is the tell — a real failure raises `severity: 'ERROR'` and a
> non-zero exit code. The command is also quiet on success, so an apparently
> empty finish is the expected one. `db:doctor` is how you confirm.

> **Check a generated migration before applying it.** Migrations 0003 and 0004
> were hand-written and never got meta snapshots, so `drizzle-kit generate` once
> diffed against 0002 and emitted six spurious `ALTER TABLE merchants ADD COLUMN`
> statements for columns that already existed. They were removed by hand; running
> them would have failed against every database that had 0003 applied.

---

## Policy

```bash
npm run policy:build   # regenerate generated.ts after editing any YAML
npm run policy:check   # fail if the committed artefact is stale
npm run replay                 # what the CURRENT table would do to real cases
npm run replay -- --case=<id>  # one case, rung by rung, with the gate reasoning
npm run dry-run:report         # what would have been sent, and what stopped it
```

Editing a YAML file without running `policy:build` leaves the compiled artefact
stale; `policy:check` is in `verify` so CI catches it.

---

## Running it

```bash
npm run dev            # the dashboard, http://localhost:3000
npm run dev:inngest    # local Inngest dev server, alongside npm run dev
npm run seed:demo -- --reset   # 320 cases through the REAL pipeline
```

The seed calls `processEvent` — the same function the webhook route calls — so
the dashboard shows data the system genuinely produced, and seeding doubles as
an end-to-end smoke test.

```bash
npm run fixtures:capture     # pull real failure payloads from Razorpay test mode
npm run templates:status     # Meta review status for the 9 templates
npm run templates:submit
npm run send:test -- --to=91XXXXXXXXXX   # one real message, end to end
npm run backfill
npm run merchant
```

---

## The human-in-the-loop jobs

```bash
npm run queue                            # cases waiting on a person
npm run queue -- --queue=risk_review
npm run queue -- --escalate=<caseId>     # queue a real case NOW, with a real brief
npm run queue -- --ack=<id> --by=<name>
npm run queue -- --resolve=<id> --note="…"
npm run queue -- --dismiss=<id> --note="…"

npm run audit                  # which cases we lost WITHOUT ever acting, and why
npm run audit -- --days=30 --merchant=<uuid>
npm run audit -- --no-ai       # buckets only, no model call

npm run triage                 # propose cause classes for unknown reasons
npm run triage -- --dry        # what WOULD be triaged, no model call
npm run triage -- --list       # pending proposals; none is ever auto-applied

npm run ai:smoke               # call all four Claude jobs for real
```

> **On PowerShell, `npm run x -- --flag=y` loses the `--` separator.** Use
> `npx tsx scripts/queue.ts --flag=y` locally. The documented form works in bash
> and CI.

---

## The console

`/recovery` is the operator surface.

**Case table** — every open case, with filters: All / Needs a touch / Contacted /
Unreachable / **Needs a person**. That last one is the set with an open
escalation, and it is distinct from *Unreachable*: that is a case we cannot
contact, this is one the agent decided not to act on alone.

**Needs a person** — open escalations and unresolved merchant alerts, above the
case table and never collapsed when non-empty. Pick up / Dismiss / Resolve.
`dismiss` ("looked, nothing to do") is kept separate from `resolve` ("fixed it")
because that ratio is how you learn whether the queue is worth having.

**Activity** — the audit trail. Every event kind the system persists, in four
lanes (Messages / AI / Decisions / System), grouped by day. See
[safety](./04-safety.md#privacy) for what it will not show you.

**Send mode** has three states, not two, because the system genuinely has three:

| Mode | Behaviour |
|---|---|
| `off` | Nothing runs. The gate aborts every rung |
| `dry_run` | Everything runs — gate, composition, ledger — and nothing is sent |
| `live` | Messages reach real recipients |

`dry_run` is the useful middle: you see exactly what would go out, to whom, with
the real copy.

---

## Verifying the AI is actually working

Failing soft is the right behaviour and it makes a dead integration look exactly
like a quiet one. Three ways to tell them apart, cheapest first:

1. **The console.** The *Needs a person* panel badges every brief `Claude · high`
   or `Fallback` (hover for the reason). The header shows a running tally
   (`AI on · 4 written, 1 fell back`) and turns red if every brief has fallen
   back.
2. **End to end, on a real case.** `npm run queue -- --escalate=<caseId>` reads
   that case's real ledger, asks Claude for a brief, and writes the queue row —
   the exact path a policy rung takes, minus the waiting. It prints whether the
   brief came from the model or the fallback. Nobody is contacted; dismiss the
   row afterwards.
3. **All four jobs.** `npm run ai:smoke`.

Run `ai:smoke` after touching **any** schema in `src/adapters/claude/`. A
malformed request shape is a 400 that the fallback swallows, and from the report
it looks identical to "no API key set".

---

## When something looks wrong

| Symptom | Look at |
|---|---|
| "Nothing is sending" | Send mode. Then `npm run audit` — the buckets name the gate condition that stopped each case |
| A case sat and did nothing | `npm run replay -- --case=<id>` — rung by rung, with the gate's own reasoning |
| Messages arriving later than the ladder says | The gate deferred them. `min_gap_minutes` and `live_attempt_lock_minutes` on the merchant both apply on **every** rung, so a second rung minutes later is a second chance to be deferred |
| Every brief says "Fallback" | `npm run ai:smoke`. Most likely an expired key or a rejected schema |
| Queries inexplicably slow | Check the function region before touching the pool. `vercel.json` pins `bom1`; functions in `iad1` against a database in `ap-south-1` cost ~250ms per query each way |
| "The database did not respond" | A wedged pooled connection. The client evicts itself on a query timeout and the next request builds a fresh one |
| A new Razorpay code appearing | `npm run triage -- --dry`, then `npm run triage` |

### Where the numbers live

- **Per-case trace** — the console's case drawer, or `case_events` directly.
- **What the agent failed to do** — `npm run audit`. This is the only view that
  answers "which cases did we lose *without acting*".
- **What would have been sent** — `npm run dry-run:report`.
- **Queue depth** — `npm run queue`, or the console panel.
