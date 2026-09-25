# 001 — Project scaffold

**Status:** complete except the manual load check · **Owner:** initial build · **Started:** 2026-09-25

## Goal

A building, testable, empty-but-correct extension skeleton. No detection logic, no model, no UI
beyond placeholders. Success is `pnpm build` producing a loadable unpacked extension and
`pnpm test` running green.

## Scope

- Toolchain: WXT, TypeScript, Vitest, happy-dom, Playwright
- Directory structure matching `docs/architecture/overview.md`
- Manifest per `technical-brief.md` §2.4
- The four entrypoints wired but inert: content script, service worker (router only),
  offscreen document, dashboard page
- CI-able scripts

## Non-goals

- Any detection logic (→ 003)
- Any model loading (→ blocked on spikes S1/S2)
- Any LinkedIn selectors (→ blocked on spike S4)
- Real UI

## Decisions applied

From `technical-brief.md`, verified against the npm registry on 2026-09-25:

| Choice | Version | Why |
|---|---|---|
| WXT | 0.21.4 | Only live framework emitting per-browser manifests. Plasmo last published 2025-05-17; CRXJS 3.0.0 has Firefox support but no `safari` or `offscreen` handling |
| Vite | 8.3.1 | WXT 0.21 peer |
| Vitest | 5.0.2 | Went 4 → 5 on 2026-09-03 — pinned deliberately |
| happy-dom | 20.14.5 | jsdom has no `IntersectionObserver` and returns `undefined` for `innerText` |
| @webext-core/fake-browser | 2.0.1 | `sinon-chrome` has been dead since 2019 |
| Playwright | 1.63.0 | E2E. Must set `channel: 'chromium'` — `headless: true` resolves to `chromium-headless-shell`, which cannot load extensions at all |

## Traps to defuse up front

1. **WXT manifest version default.** `manifestVersion ?? (browser === 'firefox' || browser === 'safari' ? 2 : 3)`.
   Set `manifestVersion: 3` explicitly and CI-assert `.output/firefox-mv3/manifest.json` exists.
2. **`onMessage` must `return true` literally.** Promise-returning `onMessage` is Chrome 148+ and
   still rolling out. Do not depend on it.
3. **happy-dom and jsdom both lack** `structuredClone` and `requestIdleCallback`, and report 0×0
   rects. Polyfill the first two in test setup; push all geometry assertions to Playwright.
4. **No `unlimitedStorage` at launch.** Try `navigator.storage.persist()` first — the permission
   widens the install warning. Add only if measurement shows eviction.

## Acceptance criteria

- [x] `pnpm build` emits a loadable Chrome MV3 extension
- [x] `pnpm build:firefox` emits an MV3 (not MV2) manifest
- [x] `pnpm test` runs and passes
- [x] `pnpm typecheck` clean
- [x] Manifest matches brief §2.4 exactly — no `<all_urls>`, no `tabs`, no `downloads`
- [x] Service worker contains routing only: no inference, no IndexedDB
- [ ] Loading unpacked in Chrome produces no console errors — **needs a human**
