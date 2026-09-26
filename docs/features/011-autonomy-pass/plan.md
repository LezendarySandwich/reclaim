# 011 — Closing the loop

**Status:** done · **Started:** 2026-09-26

Four things, chosen because each closed a loop the product had left open rather than because
they were new features.

## 1. The model's reason was computed and thrown away

`EngineJudgement.reason` was produced on every single inference and dropped before the verdict.
So the stub could only ever say "Looks like engagement bait" when the model had actually said
"comment-gated lead magnet". Now carried on the signal and persisted.

## 2. The verdict cache was written and never read

The entire point of keying on `postId + textHash + rulesVersion + engineId` (ADR-010) is that a
hit is *guaranteed* to be a verdict for this text, these rules, this model. Scrolling back over a
post re-ran a 4 GB model on text it had already judged.

`core/` stays storage-agnostic: the lookup is injected as `ClassifyDeps.lookupCached`, and a
storage failure is a cache miss rather than a classification failure.

## 3. The threshold panel had no slider

It told you precisely what moving the threshold would do and then offered no way to move it.
Settings now expose axis mode, threshold, allowlist, retention and a global pause.

Thresholds are described by the ladder rung they admit rather than as a bare number — "hides
posts the model calls 'heavily so' or stronger" is a decision; "90" is trivia. Dropping
`ai_written` below 85 shows the research warning inline, because that is where the evidence stops
supporting it.

## 4. Sampling the unmeasurable

The router's only costly mistake is clearing a post that should have been judged, and it was
**invisible by construction** — no verdict row exists for a post the model never saw. The panel
said so honestly, which was the best available answer and still an unsatisfying one.

Now 5% of cleared posts are sent to the model anyway, purely to measure. That converts an
unmeasurable into an estimable, reported as a Wilson 95% interval because a point estimate off 40
samples invites more confidence than it earns.

**The safety property: an audit sample can never hide a post.** The user has already seen it, and
retroactively collapsing it because a sampling die came up differently would be indefensible. The
pipeline forces `show`, and audit rows are excluded from headline counts and from the leaderboard
so measurement traffic cannot distort either.

## Acceptance criteria

- [x] Stub can show the model's own words
- [x] A cache hit runs no inference
- [x] Thresholds adjustable, described in rungs
- [x] Audit samples never hide, never touch aggregates
- [x] Miss rate reported with an interval, withheld below 20 samples
