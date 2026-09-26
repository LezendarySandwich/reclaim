import { browser } from 'wxt/browser'
import { LinkedInAdapter } from '../adapters/linkedin/adapter'
import { FeedWatcher } from '../content/watcher'
import type { Request, Response, TriagedPost } from '../core/messages'
import type { Verdict } from '../core/types'

/**
 * LinkedIn content script.
 *
 * Extraction, triage and stub rendering only. It does NOT run the model — spike S2 confirmed that
 * `Permissions-Policy: language-model=()` really does disable the Prompt API for a page, so
 * LinkedIn would hold a one-header kill switch over any content-script inference. Classification
 * goes to the service worker (ADR-018).
 *
 * `registration: 'runtime'` is load-bearing: a static `content_scripts` entry would read post text
 * before the user has consented, which the July 2026 Chrome Web Store user-data policy no longer
 * exempts. The service worker registers this only after consent (ADR-020).
 */
export default defineContentScript({
  matches: ['https://www.linkedin.com/feed/*'],
  runAt: 'document_idle',
  registration: 'runtime',

  main(ctx) {
    const adapter = new LinkedInAdapter()

    async function classify(posts: TriagedPost[]): Promise<Verdict[]> {
      const request: Request = { type: 'CLASSIFY_BATCH', target: 'background', posts }
      const response = (await browser.runtime.sendMessage(request)) as Response | undefined
      if (!response || !response.ok || response.type !== 'CLASSIFY_BATCH') return []
      return response.verdicts
    }

    const watcher = new FeedWatcher({
      adapter,
      classify,
      onHealth: (health) => {
        // Because we hide nothing without a model, a broken selector and a missing model look
        // identical to the user — both are "nothing happened". Log the difference so it is at
        // least diagnosable, and surface it in the dashboard later.
        if (health.status !== 'ok') {
          console.warn('[reclaim] adapter health:', health)
        }
      },
    })

    // LinkedIn is an SPA: the feed root is often not present at document_idle, and survives
    // client-side navigation away and back. Retry rather than giving up on first miss.
    let attempts = 0
    const tryStart = (): void => {
      if (watcher.start()) return
      if (++attempts > 20) return
      setTimeout(tryStart, 500)
    }
    tryStart()

    ctx.onInvalidated(() => watcher.stop())
  },
})
