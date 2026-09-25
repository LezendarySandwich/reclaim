/**
 * LinkedIn content script.
 *
 * Responsibilities: DOM extraction, heuristic triage, stub render. It does NOT run the model —
 * three reasons, all load-bearing: page-origin attribution, LinkedIn's one-header
 * `Permissions-Policy: language-model=()` kill switch, and per-tab session multiplication against
 * a multi-gigabyte model. See docs/architecture/technical-brief.md §2.3.
 */
export default defineContentScript({
  matches: ['https://www.linkedin.com/feed/*'],
  runAt: 'document_idle',

  main() {
    // TODO(004): mount the feed observer once the adapter exists.
    // Blocked on spike S4 — the LinkedIn selectors are unverified. Shipping guessed selectors
    // would silently no-op, which is indistinguishable from the extension being broken.
    console.debug('[reclaim] content script attached; adapter not yet implemented')
  },
})
