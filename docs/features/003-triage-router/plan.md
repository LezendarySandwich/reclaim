# 003 — Heuristic triage router

**Status:** in progress · **Started:** 2026-09-26

## Goal

Decide, in under a millisecond and without touching the model, whether a post is worth spending
inference on. **It routes. It does not judge** (ADR-004).

Output is a `TriageBand`: `clean` | `ambiguous` | `likely_slop`. Only `clean` skips the model.

## The asymmetry that drives every threshold

The three outcomes have wildly different costs:

| Outcome | Cost |
|---|---|
| Wrongly `ambiguous` | One unnecessary inference. Milliseconds and some battery. |
| Wrongly `likely_slop` | Same — it still goes to the model, which overrules it. |
| **Wrongly `clean`** | **The model never sees a slop post. Silent miss.** |

So `clean` is the only decision that can lose us anything, and the router is tuned to return it
only when confident. High recall into `ambiguous` is the correct bias: being unsure is cheap.

This also means the router's precision barely matters, which is what makes it safe to ship an
uncalibrated one.

## The thresholds are not known, and must not be invented

An earlier research pass published thresholds (`0.12` / `0.62`) and a feature weighting. Those came
from instrumentation with a confirmed dead-code bug and a sweep script that replayed hardcoded
scores instead of calling the router. **They are non-citable and are not used here.**

The constants in `triage.ts` are named `PROVISIONAL_*` and chosen to be conservative rather than
accurate. Calibration comes from shadow-mode data (ADR-019), not from guessing harder.

## Two sub-scores, not one

`bait` and `ai` are scored separately because ADR-019 treats them completely differently —
`engagement_bait` is default-on, `ai_written` is shadow-only. A single blended score would make
the router's behaviour depend on an axis the user cannot act on.

The band is driven by the **max** of the two: if either axis thinks a post is interesting, the
model should see it.

## Short text

Below `MIN_WORDS` (25) every rate feature is noise — one em-dash in a twelve-word post is a rate of
8 per 100 words, which means nothing. Short posts return `ambiguous` unconditionally rather than
being scored. They are cheap to classify anyway.

## Non-goals

- Producing a verdict, a score the user sees, or anything that can hide a post
- Accuracy. That is the model's job, and later a fine-tuned one's (ADR-019)

## Acceptance criteria

- [ ] `route()` returns a band, never an action
- [ ] Non-native English writing is not pushed to `likely_slop`
- [ ] Plain unornamented LLM prose reaches at least `ambiguous`
- [ ] Clean human writing reaches `clean`
- [ ] Empty / whitespace / one word / 5000 words do not throw
- [ ] Under ~1ms for a 400-word post
- [ ] `RULES_VERSION` exported and wired to the cache key
