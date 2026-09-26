/**
 * LinkedIn content script.
 *
 * Responsibilities: DOM extraction, heuristic triage, stub render. It does NOT run the model —
 * page-origin attribution, LinkedIn's `Permissions-Policy: language-model=()` kill switch (which
 * spike S2 confirmed is real and effective), and per-tab session multiplication all rule it out.
 * See ADR-018.
 *
 * `registration: 'runtime'` is load-bearing, not a preference: a static `content_scripts` entry
 * would read post text before the user has consented, which the July 2026 Chrome Web Store user
 * data policy no longer exempts. The service worker registers this only after consent (ADR-020).
 */
export default defineContentScript({
  matches: ['https://www.linkedin.com/feed/*'],
  runAt: 'document_idle',
  registration: 'runtime',

  main() {
    // TODO(006): mount the feed observer once the adapter exists.
    // Blocked on spike S4 — the LinkedIn selectors are unverified, and the modern React feed has
    // no post URN at all, so post identity is an open question. Shipping guessed selectors would
    // silently no-op, which is indistinguishable from the extension being broken.
    console.debug('[reclaim] content script attached; adapter not yet implemented')
  },
})
