# 002 — Core verdict logic

**Status:** in progress · **Started:** 2026-09-26

## Goal

The pure decision layer: signals in, show/collapse out. Safety-critical — a bug here hides
something the user wanted to read. Zero platform dependencies; testable in plain node.

## Scope

- `src/core/cache.ts` — verdict cache identity (ADR-010)
- `src/core/verdict.ts` — signal merge, threshold gate, the fail-open enforcement point

## Design decisions

**Axis modes replace the enabled/disabled boolean.** ADR-019 needs `ai_written` scored and
recorded but never hiding, which a boolean cannot express. So each axis is `off | shadow | enabled`:

| Mode | Scored | Recorded | Can collapse |
|---|---|---|---|
| `off` | no | no | no |
| `shadow` | yes | yes | **no** |
| `enabled` | yes | yes | yes |

v1 defaults: `engagement_bait: enabled`, `ai_written: shadow`, `ai_image: off`, `sponsored: off`.

**Allowlisted authors are still scored.** Their verdicts are recorded and visible in the dashboard,
they just never collapse. Two reasons: the accuracy statistic stays unbiased (excluding them would
silently drop a chunk of the denominator), and a user can see what *would* have been hidden before
deciding whether to keep someone allowlisted.

**Metadata signals may not hide on their own.** A `metadata` signal is structural fact — a platform
label, a C2PA manifest — so hiding on it is defensible and it is tempting to exempt it from the
model requirement. Rejected for v1: it creates a second path to `collapse` that does not go through
the engine-state gate, which is exactly the shape of bug ADR-005 exists to prevent. Revisit when a
metadata source actually ships (phase 3) and can be gated explicitly.

**Precedence within an axis:** model > metadata > heuristic. A heuristic signal is recorded for the
dashboard but is never the value the threshold is tested against.

## Non-goals

- Feature extraction and banding (→ 003)
- Persistence (→ 004)
- Anything touching `chrome.*`

## Acceptance criteria

- [ ] No path produces `collapse` when `canHide(engineState)` is false
- [ ] No path produces `collapse` from a heuristic signal alone
- [ ] No path produces `collapse` for a `shadow` or `off` axis
- [ ] Allowlisted authors never collapse but are still scored
- [ ] Cache key changes when any of postId / text / rulesVersion / engineId changes
- [ ] Unicode and emoji hash without collision or throwing
- [ ] `pnpm test` and `pnpm typecheck` green
