# 004 — Storage layer

**Status:** in progress · **Started:** 2026-09-26

## Goal

Local persistence for verdicts, per-author aggregates, feedback labels and settings. Nothing
leaves the machine.

## Split

| Where | What | Why |
|---|---|---|
| `chrome.storage.local` | Settings only | Small, needs synchronous-ish reads from several contexts |
| IndexedDB | Verdicts, author aggregates, labels | Thousands of rows with post excerpts; far past `storage.local`'s 10 MiB |

**`chrome.storage.sync` is banned** (ADR-014) — it uploads to Google, which would make the
on-device claim false.

## Constraints that shape the code

**IndexedDB transactions auto-close across task boundaries.** An `await` on anything that is not
an IDB request, inside an open transaction, silently kills it. This is the most common bug in this
layer, so `withTx` takes a *synchronous* callback: it is structurally impossible to await
something foreign inside a transaction through the public API.

**The offscreen document is the sole writer** (technical-brief §2.3) — it outlives the service
worker, so no keepalive fight. `db.ts` exposes writes as a single surface to make that natural.

**We deliberately do not request `unlimitedStorage`** — it widens the install warning. So we store
a bounded **excerpt** (400 chars), never the full post body, and retention is real.

## Leaderboard: incremental aggregation on write

One `get` + `put` on the author record in the **same transaction** as the verdict put. O(distinct
authors) rather than O(all posts), so it stops growing with retention.

The brief's claimed "two orders of magnitude" advantage over scan-on-read was refuted in
verification; the real gap is nearer one order. The architecture is still right, for the
complexity reason rather than the speed one.

**Ranking is by rate × volume, with a minimum-post floor.** Raw flag count makes a prolific clean
poster top the list; raw rate makes a 1-for-1 author outrank a 40-for-100 one. Both are wrong, and
the floor is what stops the second.

`rankOffenders` is a pure function over plain records, so it is tested without touching IndexedDB.

## Non-goals

- Anything that reads or writes the network
- Dashboard rendering

## Acceptance criteria

- [ ] Verdict round-trips by cache key
- [ ] Author aggregate updates atomically with the verdict
- [ ] `rankOffenders` puts 40/100 above 1/1
- [ ] Retention purge removes old, keeps new
- [ ] `purgeAll` empties everything
- [ ] No `chrome.storage.sync` anywhere in the codebase
