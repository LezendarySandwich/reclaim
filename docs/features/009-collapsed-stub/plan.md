# 009 — Collapsed stub

**Status:** done (pending real-browser a11y verification) · **Started:** 2026-09-26

## Goal

The one-line bar a hidden post collapses to (ADR-006). The most-rendered surface in the product.

## Why it gets its own isolated module

Technical brief §10 R13: stub accessibility is **entirely unresearched** and a forced-colors
failure would make the whole product unusable in high-contrast mode. Keeping DOM construction,
focus handling and announcement policy in one module with no other responsibility means that risk
is reviewable in one file.

## Decisions

**Shadow root, but not `all: initial`.** WXT's `createShadowRootUi` prepends
`:host { all: initial !important }`. That is suspected to defeat forced-colors adaptation and to
sever `rem`-based user font scaling — both of which matter most to exactly the users who need
them. We scope styles ourselves, use system colour keywords (`Canvas`, `CanvasText`, `ButtonBorder`,
`Highlight`) and size in `em`.

**No `aria-live`.** A scroll burst collapses a dozen posts and would queue a dozen announcements
over whatever the user was reading. Until debouncing is designed, silence is the accessible
choice — the stub is in the document and reachable.

**No `aria-controls`.** IDREFs do not cross shadow boundaries; it would be a dangling reference.
`aria-expanded` carries the meaning honestly.

**Conditional focus move.** Focus moves to the stub *only* if it was inside the content being
hidden — otherwise the user is stranded on an invisible element. It must not move otherwise, or
scrolling past collapsing posts would repeatedly yank focus.

**Never `display: none` on the row.** LinkedIn's infinite scroll is driven by an
IntersectionObserver sentinel; removing rows from flow starves it and the feed silently stops
loading. Two prior-art projects documented hitting this. We hide the children and keep the row.

## Acceptance criteria

- [x] Row stays in the layout flow
- [x] Author and reason shown; no score, ever
- [x] Accessible button name that works out of context
- [x] Focus moves only when it was inside the hidden content
- [x] Idempotent on a recycled node
- [x] `unmountStub` restores cleanly
- [ ] **Verified with a real screen reader and in forced-colors mode** — needs a human
