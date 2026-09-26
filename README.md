# Reclaim

A browser extension that hides AI-generated and engagement-bait posts from your LinkedIn feed.
Classification runs **on your device** — there is no account, no server, and nothing about what
you read leaves your machine.

> Early and honest about it. It works end to end, and several parts are calibrated on evidence
> that is thinner than I would like. Where that is true, the code says so.

## What it does

Scores each post on independent axes — engagement bait, templated/AI-written prose, promoted
content — and collapses the ones that cross your threshold to a one-line stub you can expand.

A local dashboard shows what was hidden, how often you disagreed, which creators post it most,
and what moving a threshold would do.

## The four rules it is built around

These are enforced in code and by tests, not just documented.

1. **Heuristics route; they never judge.** A fast pattern check decides which posts are worth
   sending to the model. It can never hide a post on its own — regex-grade rules for "AI-sounding"
   are a proxy for "non-native or formal writer", and the published false-positive rates on
   second-language writers are catastrophic.
2. **Fail open.** No model, mid-download, unsupported hardware, any error — hide nothing and say
   so. The failure mode is "it did nothing", never "it hid something you wanted".
3. **On-device only.** No post content, author, verdict or telemetry leaves the machine. There is
   no analytics endpoint. `chrome.storage.sync` is banned because it uploads to Google.
4. **Nothing destructive without explicit confirmation.** Unfollow is deliberately not in this
   extension at all.

## Running it

Requires **pnpm** — npm cannot install this dependency tree (see ADR-017).

```bash
pnpm install
pnpm build          # → .output/chrome-mv3
pnpm verify         # build + build:firefox + typecheck + test
```

Load `.output/chrome-mv3` as an unpacked extension, open its options page, and grant access.
Nothing runs until you do: the content script is registered at runtime after consent, never from
the manifest.

## How it works

```
content script          MutationObserver → extract → triage router (<1ms, routes only)
                        └─ collapsed stub + feedback
service worker          consent gate · Gemini Nano via the Prompt API · scheduler · storage
extension pages         onboarding · model install · dashboard
```

The Prompt API runs in the **service worker**, which is not the obvious choice and took a
Chromium source reading to establish: `AIPromptAPIForWorkers` is force-enabled for extension
processes, and the user-gesture requirement is skipped where there is no `Window` — so an
offscreen document, which can never obtain user activation, is the *handicapped* context here.
See ADR-018.

## Things worth knowing before trusting it

- **AI-authorship detection is unreliable at post length.** Published detectors score AUC
  0.16–0.73 on short text, and Liang et al. measured a 61.22% false-positive rate on non-native
  English writers. That axis therefore hides only at the very top of the confidence ladder, and
  the UI never renders a score or asserts authorship about a named person.
- **The thresholds are not calibrated.** They are conservative guesses constrained by evidence.
  The dashboard exists to replace them with measurements.
- **LinkedIn's terms prohibit extensions that modify the site's appearance.** This one does. The
  risk falls on the user's account, which is why it makes zero network requests to LinkedIn —
  it only reads what the page already rendered.

## Where the thinking lives

| | |
|---|---|
| `AGENTS.md` | Conventions for anyone (human or agent) working here. Read first. |
| `docs/product/decisions.md` | Append-only ADR log. 26 decisions, each with its rejected alternatives. |
| `docs/architecture/technical-brief.md` | Verified facts about Chrome, WebGPU and LinkedIn, with provenance and explicit `(unverified)` markers. |
| `docs/features/NNN-*/` | Per-feature plan and a living checklist, including what was found and *not* done. |

The docs are unusually blunt about uncertainty on purpose. Several confidently-held beliefs in
this project turned out to be wrong when measured — the Prompt API's host context, whether the
triage router's top band was reachable at all, whether ads were even being detected as posts —
and each one was found because something was written down precisely enough to be falsified.

## Licence

MIT.
