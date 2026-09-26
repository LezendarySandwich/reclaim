# 005 — Consent gate · checklist

Living. Tick on completion, **append on discovery**. See `../../../AGENTS.md`.

## Build

- [x] `linkedin.content.ts` → `registration: 'runtime'`
- [x] Manifest: `optional_host_permissions`, `scripting`, no static content script
- [x] `src/core/consent.ts` — pure state machine + user-facing copy
- [x] `src/entrypoints/background.ts` — idempotent reconcile on install/startup/permission change
- [x] Manifest assertions updated in `tests/manifest.test.ts`

## Verification

- [x] Built manifest has no `content_scripts` and no `host_permissions` — asserted
- [x] `pnpm verify` green — 188 tests, both browser builds, typecheck

## Discovered while working

_Append here. Strike through with a reason rather than deleting._

- [x] **WXT silently undid this.** It derives `host_permissions` from every content script's
      `matches` — including runtime-registered ones — so declaring `matches` put
      `https://www.linkedin.com/feed/*` straight back into the base install grant. Caught only
      because I diffed the built manifest. Fixed with a `build:manifestGenerated` hook that
      strips it, and asserted in `tests/manifest.test.ts` because a WXT upgrade could reinstate it.
- [x] `reconcileContentScript()` reconciles rather than registering. MV3 runtime registrations
      persist across browser restarts (`persistAcrossSessions: true`), so blindly calling
      `registerContentScripts` on startup throws a duplicate-id error.
- [x] `CLASSIFY_BATCH` re-checks the gate even though the content script should not be running
      without it. Defence in depth: a stale registration or a racing revoke must not produce a
      classification.

## Discovered — not done

- [ ] **No onboarding UI yet.** The gate works but nothing calls `grantConsent()`, so the
      extension is inert by construction. Ships with the dashboard.
- [ ] **No privacy policy URL.** ADR-020 requires a live one plus the Limited Use statement
      before store submission. Needs a hosted page — a real task, not a code change.
- [ ] `GATE_COPY` is the user-facing consent text and is currently my draft. It is a legal
      disclosure as much as UX copy; it should be read properly before submission.
- [ ] Revoking consent does not purge stored data. It probably should — `purgeAll()` exists.
      Decide whether revoke means "stop reading" or "stop reading and forget".
- [ ] The `webNavigation` permission is still requested but nothing uses it yet. It is for SPA
      re-attach in the adapter. If the adapter ends up not needing it, drop it — every permission
      widens the install warning.
