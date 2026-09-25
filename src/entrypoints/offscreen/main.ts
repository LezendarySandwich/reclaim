import { browser } from 'wxt/browser'
import { isRequestFor } from '../../core/messages'

/**
 * Offscreen document — model host and sole IndexedDB writer.
 *
 * This is the only context that satisfies all three constraints at once: it is a real Document
 * (so the worker gate on `AIPromptAPIForWorkers` does not apply), it is on the extension origin
 * (so a host site's Permissions-Policy cannot reach it), and it outlives the service worker's
 * 30-second idle death (so one warm model session survives across posts).
 */

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!isRequestFor(msg, 'offscreen')) return false

  void (async () => {
    // TODO(spike S2): confirm `LanguageModel` and `navigator.gpu` are both available here before
    // building the engine. If either is missing the host must move, and this file is the only
    // thing that changes.
    sendResponse({ ok: false, error: 'Model layer not implemented' })
  })()

  return true
})
