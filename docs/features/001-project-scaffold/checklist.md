# 001 — Project scaffold · checklist

Living document. Tick on completion, **append on discovery**. See `../../../AGENTS.md`.

## Toolchain

- [x] `package.json` with pinned versions
- [x] `wxt.config.ts` with explicit `manifestVersion: 3`
- [x] `tsconfig.json`
- [x] `vitest.config.ts` + test setup with `structuredClone` / `requestIdleCallback` polyfills
- [x] `.nvmrc` pinning node (23; brief said >=22, local is v23.11.0)
- [x] TypeScript major verified — using **5.9.3**, not npm `latest` 7.0.2. WXT's peer is
      `typescript: ">=5.4"` so 7 is nominally allowed, but 7.0.2 is the native Go compiler rewrite
      and untested against WXT 0.21.4. Revisit deliberately, not by bumping.

## Structure

- [x] `src/core/` — types, messages
- [x] `src/detect/` — created, empty
- [x] `src/engines/` — created, empty
- [x] `src/adapters/linkedin/` — created, empty
- [x] `src/storage/` — created, empty
- [x] `src/entrypoints/` — background, content, offscreen, dashboard, popup

## Entrypoints (inert but correct)

- [x] `background.ts` — router only. `ensureOffscreen()` via `browser.runtime.getContexts()`
      (not `hasDocument()`, Chrome 150+). Literal `return true` in `onMessage`.
- [x] `linkedin.content.ts` — matches `https://www.linkedin.com/feed/*`, `run_at: document_idle`
- [x] `offscreen/` — document + `WORKERS` reason and justification
- [x] `dashboard/` — options page placeholder
- [x] `popup/` — placeholder

## Verification

- [x] `pnpm build` succeeds — 7.99 kB total
- [x] `pnpm build:firefox` emits **MV3** with `background.scripts`; asserted in `tests/manifest.test.ts`
- [x] `pnpm test` green — 27 passed, 1 skipped
- [x] `pnpm typecheck` clean
- [x] Emitted manifest asserted against brief §2.4 in a test, not by eye
- [ ] Load unpacked in Chrome and confirm no console errors — **needs a human**, Chrome cannot
      launch from an agent session (`bootstrap_check_in … Permission denied (1100)`)

## Discovered while working

_Append here. Do not delete entries — strike them through with a reason if they turn out moot._

- [x] **npm cannot install this dependency tree.** `npm install` fails with
      `TypeError: Cannot read properties of null (reading 'edgesOut')` in arborist's
      `#loadPeerSet`, triggered while resolving vitest's optional peers (`@vitest/browser@3.2.7`,
      `@vitest/ui@3.2.7`). Reproduced on npm 10.9.2 / node 23.11.0 after a full cache clean.
      **pnpm 12.6.0 installs it in 9s.** pnpm is now required, not preferred.
- [ ] **pnpm is not properly installed on this machine.** `corepack enable pnpm` fails (writing to
      `/opt/homebrew` needs elevation), so every command currently goes through `npx --yes pnpm@12`,
      which is slow and re-resolves each time. Install it properly: `brew install pnpm` or
      `sudo corepack enable pnpm`. The `package.json` scripts assume a bare `pnpm` on PATH.
- [x] WXT 0.21.4 exports are `wxt/testing/vitest-plugin` and `wxt/testing/fake-browser` — **not**
      `wxt/testing`, which is what most docs and blog posts show. Import `fakeBrowser` from WXT's
      re-export rather than `@webext-core/fake-browser` directly, so the version stays in lockstep.
- [x] Use `browser` from `wxt/browser`, never the `chrome` global — the latter has no types here
      and would not work on Firefox.
- [x] `browser.runtime.getURL()` is typed against the project's real public paths and **requires a
      leading slash** (`/offscreen.html`). A useful guard rail: a typo in an extension path becomes
      a compile error instead of a runtime 404.
- [ ] `pnpm` wrote a `pnpm-workspace.yaml` with a `minimumReleaseAgeExclude` list (pnpm 12 gates
      brand-new releases by default). It excluded `vitest@5.0.2`, `@vitest/mocker`, `@vitest/spy`
      because they published today. Decide whether to keep that gate on — it is a mild
      supply-chain defence and we should probably want it.
- [ ] The brief's `sw.js` sample uses `chrome.runtime.sendMessage` to reach the offscreen document.
      That broadcasts to **every** extension context including the dashboard, so the offscreen
      handler needs the `target: 'offscreen'` discriminator (implemented) and every other listener
      must ignore foreign messages (implemented via `isRequestFor`). Still worth replacing with a
      dedicated `chrome.runtime.connect()` port — decide in 002.
- [ ] Decide whether the dashboard is the `options_page` or a normal extension tab. The brief's
      manifest says `options_page`, but a full dashboard in the options frame is cramped. An
      options page can open a tab; confirm before building UI.
- [ ] No linter yet. WXT's peer list includes eslint as optional. Add one before the codebase grows
      — or decide deliberately not to and rely on typecheck.
- [ ] No CI. `pnpm verify` exists and does build → build:firefox → typecheck → test; wire it to a
      GitHub Action once there is a remote.
- [ ] `playwright` is installed but there is no `playwright.config.ts` and no E2E test yet. The
      trap to encode when we add one: `headless: true` resolves to `chromium-headless-shell`, which
      **cannot load extensions at all** — must set `channel: 'chromium'`.
