# AGENTS.md

Contract for any agent (or human) working in this repo. Read this first. It is short on purpose.

## What this project is

A browser extension that hides AI-generated and engagement-bait content from social feeds,
giving control of the feed back to the person reading it. Chrome first, Firefox and Safari later.
LinkedIn first, Reddit later. All classification runs **on-device** — nothing about what you read
ever leaves your machine.

Start with `docs/README.md`. Do not start by reading `src/`.

If work is blocked on something only a human can do, record it in `docs/NEEDS-YOU.md` — that is
the one file the user is asked to read on returning, so an ask that is not in there is invisible.

## The three rules

### 1. Every feature gets a tracking folder, created before the code

```
docs/features/NNN-kebab-slug/
├── plan.md        # scope, design, acceptance criteria, non-goals
└── checklist.md   # the living task list
```

`NNN` is a zero-padded sequence number, allocated by taking the highest existing one and adding 1.
No code for a feature lands before its `plan.md` exists.

### 2. The checklist is living, in both directions

You update `checklist.md`:

- **when you complete something** — tick it, same commit as the work
- **when you discover something** — append it, immediately, even if you are not going to do it

The second half is the one that gets skipped, and it is the more important one. A checklist that
only ever shrinks is lying. If you find a bug, a missing edge case, a selector that will rot, a
test that should exist — write it down as an unticked item before you carry on. Leaving a note for
the next agent costs you thirty seconds and saves them an hour.

Mark items that turn out to be unnecessary as `~~struck through~~` with a one-line reason rather
than deleting them. Why something was dropped is information.

### 3. `docs/` and `AGENTS.md` are part of the change, not a follow-up

If your change makes something in `docs/` wrong, fix it in the same commit. If you make a decision
that a future agent would otherwise have to re-derive, record it in `docs/product/decisions.md`.
If you change how this repo is worked in, update this file.

Stale docs are worse than no docs, because they are trusted.

## Conventions

**Commits** — one logical change per commit, written so the log is readable on its own. Prefer new
commits over amending; the history is a record, not a sculpture. Conventional-commit prefixes
(`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).

**Decisions** — `docs/product/decisions.md` is an append-only ADR log. Superseding an earlier
decision means adding a new entry that says so, not editing the old one.

**Architecture boundaries** — these exist so that adding Reddit, or ad-filtering, or a new model
backend is a new file rather than a refactor. Respect them:

| Directory | Rule |
|---|---|
| `src/core/` | Zero platform dependencies. No `chrome.*`, no DOM. Pure types and logic. Must be unit-testable in plain node. |
| `src/detect/` | Heuristics and prompts. **Heuristics triage, they never judge** — see below. |
| `src/engines/` | One file per model backend, behind the `ModelEngine` interface. |
| `src/adapters/` | One directory per site, behind the `SiteAdapter` interface. Site-specific selectors live here and nowhere else. |
| `src/entrypoints/` | Thin. Wiring and lifecycle only — no detection logic. |

**Invariants that are not negotiable.** Each of these is a product decision, not a style preference.
If you think one is wrong, raise it and update `decisions.md` — do not quietly work around it.

1. **Heuristics route, they never hide.** Cheap in-tab scoring decides *what reaches the model*.
   It never produces a `collapse` on its own. A user with no working model must see an unfiltered feed.
2. **Fail open.** No model, no WebGPU, mid-download, unsupported hardware, any error — hide nothing
   and say so in the UI. The failure mode of this extension is "it did nothing", never "it hid
   something you wanted".
3. **On-device only.** No post content, no author, no verdict, no telemetry leaves the machine.
   There is no analytics endpoint. If you add a network call, it needs a decision-log entry.
4. **Nothing is destructive without an explicit, per-action confirmation.** Unfollow and
   disconnect are irreversible and driven by a fallible classifier. Treat them accordingly.

## Package manager

**Use pnpm. npm does not work** — it dies with `Cannot read properties of null (reading 'edgesOut')`
resolving vitest's optional peers. See ADR-017. `pnpm verify` runs build → build:firefox →
typecheck → test and is what CI should run.

## Testing

`src/core/` and `src/detect/` are pure and must have unit tests. Adapter extraction logic is
tested against captured HTML fixtures, not a live site. Anything touching `chrome.*` gets an E2E
test or an explicit note in the checklist saying why not.

When a selector breaks in the wild, the fix includes a fixture that would have caught it.

## Naming

The project name `reclaim` is provisional and appears in `package.json`, the manifest, and doc
headings. It is not load-bearing — renaming is a find-and-replace, so do not design around it.
