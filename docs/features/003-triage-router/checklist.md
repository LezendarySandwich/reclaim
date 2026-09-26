# 003 — Heuristic triage router · checklist

Living. Tick on completion, **append on discovery**. See `../../../AGENTS.md`.

## Build

- [x] `src/detect/features.ts` — pure feature extraction, all features normalised 0-1
- [x] `src/detect/features.test.ts`
- [x] `src/detect/triage.ts` — `route()`, `RULES_VERSION`, provisional thresholds
- [x] `src/detect/triage.test.ts`
- [x] `src/detect/index.ts`

## Verification

- [x] Non-native English samples do not reach `likely_slop`
- [x] Plain LLM prose reaches at least `ambiguous` — only after fixing two regex bugs, see below
- [x] Performance ceiling asserted
- [x] `pnpm test` / `pnpm typecheck` green — 138 passing

## Discovered while working

_Append here. Strike through with a reason rather than deleting._

- [x] **The "plain LLM prose reaches ambiguous" test failed on the first run**, exactly as
      anticipated. Diagnosing rather than loosening it found two real bugs:
      - `ANTITHESIS` missed "X is not about Y. It is about Z.", the commonest LLM form. It only
        matched contracted `it's` openers. Two further rewrites were needed: the right-hand side
        demanded `it` + whitespace + `'s` (a contraction has no space), and the comma-spliced
        variant "Success is not luck, it is preparation." needed an uncontracted verb.
      - `TRICOLON` required single-word items (`faster, cheaper, and better`) and therefore missed
        every realistic phrasal instance.
      - `COMMENT_GATE` required a contraction and missed "and I will send you".
- [x] **`abstractness` is the strongest separator in the sample corpus** — generic LLM prose 1.00
      vs 0.15-0.23 for specific human writing. Promoted from a discount factor to a weighted
      feature, which is what moved plain LLM prose from `clean` to `ambiguous`.
- [x] Measured separation after the fixes (hand-written corpus, NOT a calibration):
      clean human 0.04-0.06 · non-native 0.14-0.28 · plain LLM 0.40-0.50 · thresholds 0.18/0.55.
      Note the overlap between non-native and LLM. That is the Liang effect appearing in our own
      data, and it is precisely why nothing in this module may hide a post.

## Discovered — not done

- [ ] **The corpus is 9 hand-written samples.** It pins committed behaviour, not accuracy. Every
      number above is anecdote until shadow mode produces real data. Do not let anyone cite them.
- [ ] `PROVISIONAL_CLEAN_BELOW` / `PROVISIONAL_SLOP_ABOVE` remain uncalibrated guesses.
      Calibrate per word-count bucket (ADR-019 point 7), not as a single global scalar.
- [ ] **`likely_slop` is currently unreachable in testing** — nothing in the corpus exceeds 0.55.
      Either the threshold is too high or the band is redundant, since `ambiguous` and
      `likely_slop` both route to the model and nothing else consumes the distinction yet.
      Decide whether the band earns its place once real data exists.
- [ ] No feature captures the fabricated-specificity failure: five invented statistics score as
      highly concrete and suppress the ai score. Unsolved, and possibly unsolvable here.
- [ ] `PROPER_NOUN` uses lookbehind, which is fine in modern browsers but will mis-score
      languages without capitalisation (CJK scores 0 concreteness, so all CJK posts look maximally
      abstract). LinkedIn is heavily non-English — this needs a script-aware guard.
- [ ] Hedging/antithesis/tricolon word lists are English-only. Same problem, wider.
