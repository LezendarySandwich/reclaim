# 005 — Consent gate

**Status:** in progress · **Started:** 2026-09-26

## Goal

No post text is read until the user has affirmatively consented, and the LinkedIn host permission
is granted during onboarding rather than at install.

## Why this is mandatory, not polish

The Chrome Web Store User Data policy changed in July 2026 (Wayback-diffed; landed between
2026-06-28 20:15 UTC and 2026-07-03 15:24 UTC). Google:

- deleted the qualifier "personal or sensitive" from "user data" throughout,
- added an FAQ entry stating local-only storage **still requires disclosure**,
- **deleted the exemption** for data handling "closely related to functionality described
  prominently".

Under the old rules we were exempt. We are not now. A static `content_scripts` entry reads user
data before consent exists, which is the shape of thing that gets a listing rejected.

See ADR-020.

## Design

| Before | After |
|---|---|
| `content_scripts` in the manifest | `registration: 'runtime'`, registered by the service worker after consent |
| `host_permissions: linkedin.com` | `optional_host_permissions`, requested from the onboarding page |
| — | `scripting` permission, to register at runtime |

Consent is a timestamp in `chrome.storage.local`. The service worker registers the content script
on startup **only** if consent exists and the host permission is still granted, and unregisters
when either is withdrawn.

**The permission request must come from a user gesture on an extension page**, so onboarding lives
in the dashboard — which is also where the model download has to be initiated (ADR-018). One page,
both gestures.

## Failure modes this must handle

- Consent given, permission later revoked in `chrome://extensions` → unregister, return to
  `needs_setup`. Polling for this is wasteful, so listen to `permissions.onRemoved`.
- Registration surviving a browser restart — MV3 registered scripts persist, so registering again
  on every startup would throw a duplicate-id error. Reconcile rather than blindly register.
- The user revoking consent in our own UI → unregister and purge.

## Non-goals

- The onboarding UI itself (placeholder for now; real UI ships with the dashboard)
- Privacy-policy hosting — needed before submission, tracked in the checklist

## Acceptance criteria

- [ ] No `content_scripts` key in the built manifest
- [ ] No `host_permissions` key; LinkedIn appears under `optional_host_permissions`
- [ ] Content script is not registered without consent
- [ ] Registration is idempotent across restarts
- [ ] Revoking the host permission unregisters
