# What I need from you

**Last updated: 2026-09-26.** Written while you were away. Read the top section, skim the rest.

Two things block real progress. Everything else is either done or buildable without you.

---

## 1. Run spike S4 — the LinkedIn DOM audit

**Blocks:** the adapter, and therefore anything you can actually see working. This is the single
highest-value thing you can do.

It's read-only, no extension involved, no server. Nothing like the mess S2 turned into.

1. Open a logged-in `https://www.linkedin.com/feed/`, scroll to the top
2. DevTools console
3. Paste `scripts/spikes/linkedin-dom-audit.js` (it's on your clipboard from earlier)
4. Run `await linkedinDomAudit()`
5. Paste me the JSON, or save it to `docs/features/006-linkedin-adapter/s4-results.json`

Takes ~20s — it scrolls the feed to test whether LinkedIn recycles DOM nodes.

**Why it matters more than I thought.** The research found LinkedIn is mid-migration between two
completely different feeds, and the new React one has **no post URN at all** — no `data-urn`, no
`data-id`, nothing. In 10 captured fixtures from a maintained filter project there wasn't a single
one. So post identity has to be derived, and that decision blocks history, metrics *and* the
leaderboard. The audit settles it in one pass.

**Ideally run it twice:** once on `?feedView=recent`, once on the default feed. And if you have a
second account, there too — the two feed builds appear to be rolled out per-user, so I need to
know which one you actually have.

---

## 2. Finish spike S2 — where the model can run

**Blocks:** the model layer. Less urgent than it was, because the research largely answered it
from Chromium source, but it's the one assumption that most changes the build.

```
cd ~/projects/reclaim
./scripts/spikes/s2-prompt-api-context/RUN-ME.sh
```

**Quit Chrome completely first** (Cmd-Q). The script now refuses to run otherwise, and that's why:
a live Chrome swallows the URLs into your existing window and drops every command-line flag, which
is how the probe extension nearly ended up in your real profile.

It will pause and print a box. In the Chrome window it opens: `chrome://extensions` → Developer
mode on → **Load unpacked** → `scripts/spikes/s2-prompt-api-context/ext`. Chrome ignores
`--load-extension` now, so this step can't be automated.

**Run it in a real Terminal, not with `!` in the session** — it's a 4-minute interactive script
and the output doesn't stream properly through the harness. That's why it looked like it printed
nothing last time.

What it settles: whether `LanguageModel` and `navigator.gpu` work in a service worker, an
offscreen document, and a content script. `python3 report.py` re-prints results any time.

---

## 3. Two small things, whenever

- **`brew install pnpm`.** Every command currently goes through `npx --yes pnpm@12` because
  `corepack enable` can't write to `/opt/homebrew`. npm genuinely cannot install this project
  (ADR-017), so pnpm isn't optional.
- **Decide on the name.** `reclaim` is a placeholder I picked. It's in `package.json`, the
  manifest and doc headings — a find-and-replace, nothing designed around it.

---

## Decisions I'd like your eye on

I made these while you were away. All reversible, all recorded in `docs/product/decisions.md`.
Flagging the ones where I'd understand you disagreeing.

**ADR-019 — `ai_written` ships shadow-only; `engagement_bait` is the default-on axis.**
This is the big one, and it changes what the product *is* on day one. The detection literature is
brutal: at post length, published detectors score AUC 0.16–0.73 (sometimes below chance), prompted
frontier models manage 0.53–0.73 against a 0.50 baseline, and Liang et al. measured a **61.22%
false-positive rate on non-native English writers**. LinkedIn is the most formal-register platform
there is, so that's the dominant failure mode, not an edge case. Engagement bait is a different
kind of problem — the text states its own intent, you can verify a flag instantly, and a false
positive is embarrassing rather than defamatory.

Net effect: v1 hides engagement bait and *measures* AI-authorship without acting on it. You can
flip `ai_written` on in settings, behind an explicit unreliability panel. If you want it default-on,
say so — but the honest path to that is a fine-tuned classifier, not a better prompt.

**ADR-018 — the Prompt API engine moves to the service worker.** Straight reversal of ADR-009,
which I got wrong. Chromium force-enables `AIPromptAPIForWorkers` for extension processes, and the
user-gesture check is skipped entirely in workers — while an offscreen document is a Window that
can *never* obtain user activation, so it can never start the model download. The offscreen
document is the handicapped context, not the privileged one. It's kept for WebLLM, which genuinely
needs it.

**ADR-021 — zero network requests to LinkedIn, ever.** LinkedIn's terms have no display-only
carve-out — "modify the appearance of" is named explicitly, and v1 breaches it. The remedy runs
against *your users' accounts*, not us, so minimising detectability is an obligation. A passive
DOM reader is close to undetectable; one extra XHR is a fingerprint. I also think we should say so
plainly in onboarding rather than bury it.

**ADR-020 — consent gate before any post text is read.** The Chrome Web Store user-data policy
changed in July 2026 and deleted the exemption we'd have relied on. This forces a real code change:
dynamic content-script registration after consent, and the LinkedIn host permission requested
during onboarding rather than at install. **Implemented** — but nothing can *grant* consent until
the onboarding UI exists, so the extension is currently inert by construction. That is correct
behaviour, not a bug.

---

## Where the code actually is

**Docs and code across 14 commits. 188 tests passing, typecheck clean, builds for Chrome and Firefox.**

| Layer | State |
|---|---|
| Scaffold, manifest, entrypoints | Done. Builds both browsers, manifest asserted by test |
| `src/core/` — verdict merge, cache identity | Done, heavily tested |
| `src/detect/` — triage router | Done. Thresholds deliberately uncalibrated |
| `src/storage/` — IndexedDB, aggregates, settings | Done |
| `tests/invariants.test.ts` | Codebase-wide guards for the four non-negotiables |
| `src/adapters/linkedin/` | **Empty — blocked on S4** |
| `src/engines/` | **Empty — blocked on S2** |
| Dashboard / popup UI | Placeholders |
| Consent gate (ADR-020) | Done — gate, manifest, runtime registration. No onboarding UI yet, so nothing can *grant* consent |

Run `pnpm verify` (build → build:firefox → typecheck → test) to see it all green.

### One thing I want to flag honestly

The triage router's test "plain LLM prose reaches at least ambiguous" **failed on first run**. I
fixed three real regex bugs rather than loosening the assertion, and it passes now. But the
measured separation is: clean human 0.04–0.06, **non-native English 0.14–0.28**, plain LLM
0.40–0.50. Non-native and LLM overlap. That's the Liang effect appearing in our own tiny corpus,
and it's exactly why nothing in that module is allowed to hide a post. The corpus is nine
hand-written samples — it pins behaviour we've committed to, not accuracy. Don't let anyone
(including me) cite those numbers as measurement.

---

## What I'll do next without you

In order:

1. ~~Consent gate~~ — done.
2. `SiteAdapter` interface and the LinkedIn adapter skeleton, against the candidate selectors the
   research found (`[data-testid="mainFeed"]`, `componentkey^="expandedFeedType_"`,
   `[data-testid="expandable-text-box"]`) — structured so your S4 results drop straight in.
3. `ModelEngine` interface and a Gemini Nano engine, behind the message boundary, so relocating
   the host stays a one-file change if S2 surprises us.
4. The collapsed stub, in a shadow root, with the infinite-scroll fix prior art says we'll need on
   day one.
5. Dashboard.

---

## Background: the two failed workflows

Both research/build workflows died with agents stalling for 3 minutes repeatedly — I had ~60
running concurrently. Infrastructure, not prompts.

The research one got 29 of 55 agents through first, and **all six fetch dimensions completed**, so
nothing was lost: 97 findings and 108 verbatim quotes are written up in
`docs/architecture/technical-brief-addendum.md` with an explicit caveat that they're
primary-sourced but only partly adversarially verified.

The build one produced nothing, so I wrote those three modules myself. That turned out better —
the modules have to agree with each other, and one author beats three parallel ones for that.
