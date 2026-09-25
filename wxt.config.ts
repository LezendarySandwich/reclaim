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
      'offscreen', // hosts the on-device model — the only context where it can run
      'storage', // settings only; post history lives in IndexedDB
      'alarms', // retention purge and the model-drift canary
      'webNavigation', // LinkedIn is an SPA; content scripts need re-attach on route change
    ],

    host_permissions: ['https://www.linkedin.com/*'],

    // Any WebLLM CDN origin is requested at upgrade-install time, never bundled into the base
    // grant — a model download the user did not ask for should not be pre-authorised.
    optional_host_permissions: [],

    options_page: 'dashboard.html',
  },
})

// Deliberately absent, and each omission is a decision:
//   <all_urls>        — we target one site
//   tabs / activeTab  — content scripts + webNavigation cover everything we need
//   cookies           — we never read the user's session
//   downloads         — JSONL export uses a blob anchor from the dashboard page
//   unlimitedStorage  — widens the install warning. Try navigator.storage.persist() first and
//                       add this only if measurement shows eviction.
