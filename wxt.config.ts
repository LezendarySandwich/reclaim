import { defineConfig } from 'wxt'

// Manifest is documented in docs/architecture/technical-brief.md §2.4.
// Every permission here has a written justification; do not add one without updating that section.
export default defineConfig({
  srcDir: 'src',

  // TRAP: WXT defaults to `manifestVersion ?? (browser === 'firefox' || browser === 'safari' ? 2 : 3)`.
  // Without this line a Firefox build silently emits MV2. tests/manifest.test.ts asserts MV3.
  manifestVersion: 3,

  manifest: {
    name: 'Reclaim',
    description:
      'Hides AI-generated and engagement-bait posts from your feed. Classification runs on your device.',
    minimum_chrome_version: '138',

    permissions: [
      'storage', // settings and consent only; post history lives in IndexedDB
      'alarms', // retention purge and the model-drift canary
      'webNavigation', // LinkedIn is an SPA; content scripts need re-attach on route change
      'scripting', // register the content script at runtime, after consent (ADR-020)
    ],

    // NO static `host_permissions` and NO static `content_scripts`. Both are deliberate: the
    // July 2026 Chrome Web Store user-data policy removed the exemption that let us read post
    // text before obtaining consent, so access is requested during onboarding from a real user
    // gesture and the content script is registered only once consent exists. See ADR-020.
    optional_host_permissions: [
      'https://www.linkedin.com/*',
      // A WebLLM CDN origin will be added here when that tier ships — requested at
      // model-install time, never pre-authorised.
    ],

    options_page: 'dashboard.html',
  },

  hooks: {
    /**
     * WXT derives `host_permissions` from every content script's `matches`, including
     * runtime-registered ones — so declaring `matches` on the LinkedIn script silently puts
     * `https://www.linkedin.com/feed/*` back into the base grant and undoes ADR-020.
     *
     * We need `matches` on the entrypoint (the service worker reads it when registering at
     * runtime), so strip the derived permission here instead. `tests/manifest.test.ts` asserts
     * the result, because this is exactly the sort of thing a WXT upgrade could quietly reinstate.
     */
    'build:manifestGenerated': (_wxt, manifest) => {
      delete (manifest as { host_permissions?: string[] }).host_permissions
    },
  },
})

// Deliberately absent, and each omission is a decision:
//   <all_urls>        — we target one site
//   tabs / activeTab  — content scripts + webNavigation cover everything we need
//   cookies           — we never read the user's session
//   downloads         — JSONL export uses a blob anchor from the dashboard page
//   unlimitedStorage  — widens the install warning. Try navigator.storage.persist() first and
//                       add this only if measurement shows eviction.
//   offscreen         — the Prompt API runs in the service worker (ADR-018). An offscreen
//                       document is only needed for the deferred WebLLM tier (ADR-022), so the
//                       permission returns with the engine that justifies it.
