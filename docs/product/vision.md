# Vision

## The problem

Social feeds have filled up with text nobody wrote and nobody wants to read. LinkedIn is the
worst of it: generated posts, engagement bait, the same viral template reposted forty times. The
platform has no incentive to filter this, because it engages. The reader has no control.

The ranking algorithm decides what you see. This puts a filter you own in front of it.

## The principle

**Control belongs to the person reading.** Every design decision follows from this:

- The classifier runs **on your machine**. What you read is not data for anyone else. There is no
  server, no account, no telemetry.
- It **fails open**. If the model cannot run, you get an unfiltered feed — never a silently
  censored one. The failure mode is "it did nothing".
- It **shows its work**. Hidden posts collapse to a visible stub, not a hole. You can always see
  what it took and disagree with it.
- **You set the threshold**, per category. It is your tolerance, not ours.

A tool that decides for you is just another algorithm. The difference is who holds the dial.

## What it does

Scores each post in the feed on independent axes — AI-written prose, engagement bait, and later
AI-generated images and sponsored content — and collapses the ones that cross your threshold to a
one-line stub you can expand.

A local dashboard shows what was hidden, how accurate the classifier has been against your own
👍/👎 feedback, and which creators are the repeat offenders in your feed. That last one is the
actionable part: the fix for someone who posts generated slop daily is not to filter them forever,
it is to stop following them.

## Roadmap

**Phase 1 — LinkedIn, end to end.** Feed filtering with on-device classification, the collapsed
stub, the feedback loop, the dashboard, and the creator leaderboard. One site done properly,
including the parts that are unglamorous: model download UX, fail-open states, selector rot.

**Phase 2 — Breadth.** Reddit. Sponsored and ad content as additional axes. Firefox.

**Phase 3 — Images.** AI-generated image detection, starting with high-precision signals
(C2PA / Content Credentials, platform labels) before anything pixel-based. The architecture leaves
the seam for this in phase 1; see `architecture/overview.md`.

**Phase 4 — Acting on it.** One-click unfollow of repeat offenders, with exclusions and a
confidence floor. This is deliberately last: it is irreversible, it is driven by a fallible
classifier, and it carries real account risk. It does not ship until the classifier has earned
trust against real feedback data, and it never runs without explicit per-action confirmation.

Safari is aspirational and gated on whether web extensions there can run a local model at all.

## Non-goals

- **Not a fact-checker.** "Written by an AI" and "wrong" are different claims. We only make the first.
- **Not a moderation tool.** This filters your own view. It does not report, flag, or affect anyone else.
- **Not a growth product.** No accounts, no cloud sync, no social layer, no leaderboard anyone else sees.
- **Not an anti-AI statement.** The target is low-effort content published without care. A thoughtful
  post that used an LLM to tidy the grammar is not the problem; a daily listicle nobody read before
  posting is.

## How we will know it works

The honest metric is the feedback loop. If the accuracy stat computed from your own 👍/👎 labels
is not good, the product does not work, and the dashboard will say so rather than hide it.
Everything else — posts hidden, time saved — is vanity.
