# Where this runs, and why it matters

`vercel.json` pins every serverless function to **`bom1` (Mumbai)**. That single
line is the fix for the longest-running production problem this app had, so it
is worth writing down why it exists before someone removes it.

## The symptom

Requests that intermittently never came back. `/api/recovery/status` returning
"The database did not respond", webhook deliveries dying half-processed, the
console showing a stale-data banner every few minutes. Meanwhile the database
was idle — ten connections of sixty, no blocked locks, and `select 1` answering
in ~220ms when measured from a laptop.

## The cause

Vercel was executing functions in **`iad1` (Washington DC)**. Supabase is in
**`ap-south-1` (Mumbai)**. Every query crossed about twelve thousand kilometres
and back.

```
X-Vercel-Id: bom1::iad1::wkzp6…
             ^^^^  ^^^^
             edge  function region   <- the request entered in Mumbai
                                        and was executed in Virginia
DATABASE_URL: …aws-0-ap-south-1.pooler.supabase.com   <- data lives in Mumbai
```

At roughly 250ms of round-trip latency per query, a status poll making five or
six of them spends well over a second in flight before doing any work. Add two
overlapping requests and the client-side deadline starts firing — not because
anything is broken, but because the speed of light through fibre is not
negotiable.

Every other symptom followed from that:

- **`max: 1` was catastrophic.** One connection meant every concurrent request
  on an instance serialised behind a queue of 250ms round trips. Measured: three
  concurrent polls, all three timing out against a healthy database.
- **A longer deadline did not help.** Doubling it to 20s produced the same
  failure count, twice as slowly — the queue was growing faster than the budget.
- **It looked like a stale connection** because that is what the error said. The
  timeout could not distinguish "this socket is dead" from "this query is 40th
  in line", so it reported the only cause it knew.

## The rule

**The function region and the database region must match.** If the database
moves, this file moves with it. A cross-region deployment of this app does not
degrade gracefully — it degrades into intermittent, misleading timeouts that
look like a database fault and are not.

Check it any time latency looks wrong:

```bash
curl -sI https://www.vyavas.com/api/health | grep -i x-vercel-id
# bom1::bom1::…  <- correct: edge and function both in Mumbai
# bom1::iad1::…  <- wrong: the function is executing a continent away
```

## What is still deliberate

`src/db/client.ts` keeps its client-side query deadline and its small
connection pool. Colocation makes those far less likely to trigger, but they are
still the thing that stops a genuinely dead socket from hanging a request
forever — which does happen, because serverless instances freeze between
invocations and the pooler is free to drop an idle connection without the frozen
process ever noticing.
