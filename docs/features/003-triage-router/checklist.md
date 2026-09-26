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

- [x] **Emoji handling was badly under-built** (raised by the user, and they were right).
      `emojiBulletRate` only inspected `line.slice(0, 3)`, so it missed leading whitespace, could
      slice a surrogate pair in half, and measured nothing about the rest of the post. Added:
      - `emojiDensity` — emoji per 100 words anywhere in the post
      - `slopEmojiRate` — density of a hand-picked 30-emoji set (🚀 💡 ✅ 👉 🔥 …), the vocabulary
        generated LinkedIn listicles actually use
      - `emojiBulletRate` rewritten to anchor at line start allowing indentation
      Kept density and the slop set SEPARATE on purpose: emoji use is cultural and generational,
      so penalising it broadly would be another demographic proxy. What discriminates is *which*
      emoji, not *whether*. Measured: an emoji listicle scores 0.310 and a 👉-bulleted post 0.325,
      while a human post containing 😅 stays at 0.052 and routes `clean`.

- [x] **`likely_slop` was DEAD in production** and nothing caught it. Spotted from the dashboard's
      agreement panel reading 0 in both of its likely_slop rows on real data.
      Cause was a modelling error, not a threshold that needed nudging: `weightedScore` divided by
      the SUM of all weights, and `BAIT_WEIGHTS` sums to ~2.95 — so a post firing only
      `commentGate` (the strongest single marker, 0.85) scored 0.29, and a post had to fire most
      markers simultaneously to score highly. These markers are independent evidence, not
      competing components of an average.
      Replaced with noisy-OR: `1 - Π(1 - wᵢvᵢ)`. Measured after the change — clean human 0.03-0.10,
      non-native English 0.18-0.39, real bait 0.65-0.98. The fairness guarantee holds and the
      separation is much cleaner.
      Two regression tests added: unambiguous bait must reach `likely_slop`, and a single decisive
      marker must be enough on its own.
- [x] Two of those new regression fixtures initially failed at 21 and 23 words — below `MIN_WORDS`,
      so they short-circuited and were testing the length guard rather than the scoring. Lengthened
      to realistic posts.
- [ ] Non-native writing moved from `clean` to `ambiguous` under the new combination, so it now
      reaches the model more often. Safe direction — the model judges, not the router — but it is
      a small unmeasured increase in inference cost.

## Two real missed posts — 2026-09-26

Reported from a live feed. Measured rather than guessed, and they exposed three genuine gaps.

| Post | Before | After |
|---|---|---|
| HTTP status codes as managers (emoji listicle, ends "What's your favorite HTTP code?") | **`clean`** 0.136 — never reached the model | `ambiguous` 0.500 |
| "What your interview drink says about you" (12-item `Term: description` list) | `ambiguous` ai 0.200 | `ambiguous` ai 0.430 |

- [x] **No feature for the `Term: description` listicle** — the commonest machine-written shape on
      LinkedIn, and both misses were built entirely from it. Added `labelledListicle`, weighted on
      both sides. It is structural rather than lexical, which is why it can carry real weight
      without being a proxy for non-native or formal writing.
- [x] **`concreteness` treated digit soup as substance.** The HTTP post scored a perfect 1.00 on
      digit density alone — status codes 200/403/404/429/503 — which zeroed its `abstractness`
      (the heaviest ai weight) AND applied a 30% discount to the rest. Numbers doubly suppressed
      it. Digits now weigh 0.35 against proper nouns at 0.65, and the discount drops 0.3 → 0.15.
      This is the fabricated-specificity failure logged earlier as unsolved, except the numbers
      here were real — the lesson generalises: being full of numbers is not being about something.
- [x] **`questionCloser` was a phrase list** and missed "What's your favorite HTTP code?". Now
      structural: any question as the final line. A post ending by asking you something is
      fishing for comments whatever the wording.
- [x] Added `bulletRate` for non-emoji bullet glyphs (•, -, →). The HTTP post's list used `•`,
      which `emojiBulletRate` ignored entirely.
- [x] Prompt v2: the system prompt now describes the `Term: description` shape explicitly and
      states that **accuracy does not redeem it** — an explainer can be correct, useful and still
      entirely templated. Two few-shot anchors added using these exact two shapes, since the
      anchors do most of the calibration work.

- [ ] Whether the MODEL now rates these `blatant` is unverified. The router escalates them, which
      is its whole job, but only a live run shows what Nano actually says. `ai_written` hides only
      at `blatant` (ADR-025), so a `strong` rating still leaves them visible.
- [ ] The HTTP post's concreteness is still 1.00 — it has genuine proper nouns too. The fix
      reduced the damage rather than removing it.
