# 010 — Dashboard metrics

**Status:** in progress · **Started:** 2026-09-26

## Goal

Answer "is this thing any good?" — the question ADR-007 says is the only one that matters early.

Requested: breakdown by axis, who detected what, posts hidden over a window, and authors who do it
consistently.

## One reframe, because the obvious version would lie

**"Regex vs model" as a detector breakdown is meaningless here.** Heuristics never hide (ADR-004),
so the detector for every hidden post is always the model. That panel would read 100% model.

What is actually informative is **router↔model agreement**:

| Router said | Model said | Meaning |
|---|---|---|
| `likely_slop` | high | agreed — router is working |
| `ambiguous` | high | router correctly escalated |
| `likely_slop` | low | router over-fired — costs inference, no harm |
| `clean` | *never asked* | **the expensive case** — a silent miss we cannot measure |

That last row is the honest gap: posts routed `clean` never reach the model, so we cannot know
what we missed. The dashboard must say so rather than implying the numbers are complete.

Similarly, `ai_written` is shadow-only, so it cannot appear under "hidden by axis". But
**"would have hidden N posts"** is precisely how you decide whether to turn it on — so shadow
counts get their own panel rather than being hidden or, worse, silently mixed into the real ones.

## Panels

1. **Overview** — hidden today / 7d / 30d, and what fraction of scored posts that is
2. **By axis** — `engagement_bait` hidden; `ai_written` shadow-only with a "would have hidden" count
3. **Router agreement** — agree / escalated / over-fired, plus posts skipped entirely, and an
   explicit note that `clean` misses are unmeasurable
4. **Recently hidden** — last N with author, reason, score, and a "this was wrong" control
5. **Repeat posters** — rate × volume with a minimum-post floor (already in `aggregates.ts`)

## Non-goals

- Charts. Counts and a sorted table answer these questions; a chart library does not earn its
  bundle weight yet.
- Exporting labels. Needs its own consent wording (ADR-008).

## Acceptance criteria

- [ ] Verdicts persist from the service worker
- [ ] Every panel reads from IndexedDB, not from memory
- [ ] Shadow-mode counts are visually distinct from real hides
- [ ] Unmeasurable gaps are stated, not implied away
