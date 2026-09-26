# docs/

Everything a newcomer — human or agent — needs before touching code. Read `../AGENTS.md` first
if you have not.

## Map

| Path | What it holds | Read it when |
|---|---|---|
| `NEEDS-YOU.md` | Open asks for the human, and current build state | **Start here if you have been away** |
| `product/vision.md` | What we are building and why, plus the phase roadmap | Orienting for the first time |
| `product/decisions.md` | Append-only ADR log. Every settled decision and its reasoning | Before proposing a change to how something works |
| `architecture/overview.md` | The system: execution contexts, seams, data flow | Before writing code anywhere |
| `architecture/execution-contexts.md` | What runs where and what each context can and cannot do | Working on the model layer or messaging |
| `architecture/technical-brief.md` | Verified external facts: API surfaces, platform limits, policy | Before assuming anything about Chrome, WebGPU, or LinkedIn |
| `features/NNN-*/` | Per-feature plan and living checklist | Working on that feature |

## How to maintain this

**`technical-brief.md` is evidence, not opinion.** It records what was verified against primary
sources, with URLs and dates. Browser APIs and LinkedIn's DOM both rot. When you discover a fact
in the brief is out of date, correct it *and* note the date you re-verified. Anything in there
marked `(unverified)` is a landmine — treat it as an open question, not a fact.

**`decisions.md` is append-only.** Superseding a decision means writing a new entry that says
"supersedes ADR-00N", not editing the old one. The wrong turns are worth keeping; they stop the
next person retaking them.

**`features/`** — numbered folders, allocated sequentially. A feature folder outlives the feature:
when it ships, the checklist stays as the record of what was built and what was knowingly left out.

## Conventions in these files

- Lead with the conclusion. A reader should be able to act after the first paragraph of any section.
- Cite a URL for any external claim. No URL, no claim.
- Mark uncertainty explicitly rather than smoothing it over. `(unverified)` and `(spike needed)`
  are useful; confident prose covering a guess is not.
- Prefer a table over a list when comparing, a diagram over a paragraph when describing flow.
