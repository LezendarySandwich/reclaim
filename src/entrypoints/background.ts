import { browser } from 'wxt/browser'
import { errorResponse, isRequestFor } from '../core/messages'
import type { Response } from '../core/messages'

/**
 * Service worker — ROUTER ONLY.
 *
 * No inference (the Prompt API is gated off in workers behind `AIPromptAPIForWorkers`, which has
 * no chrome://flags entry) and no IndexedDB (the offscreen document is longer-lived and owns
 * writes, which keeps the SW-keepalive fight out of the storage design entirely).
 *
 * See docs/architecture/technical-brief.md §2.
 */

// Leading slash required: WXT types getURL() against the set of real public paths.
const OFFSCREEN_PATH = '/offscreen.html' as const

let creating: Promise<void> | null = null

/**
 * Race-free. Only one offscreen document may exist per extension, and concurrent content scripts
 * will both try to create it — `createDocument` throws if one already exists.
 */
async function ensureOffscreen(): Promise<void> {
  // getContexts() is Chrome 116+. Deliberately not hasDocument(), which is Chrome 150+ and newer
  // than our floor of 138.
  const existing = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [browser.runtime.getURL(OFFSCREEN_PATH)],
  })
  if (existing.length > 0) return

  if (creating) return creating

  const pending = browser.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      // There is no AI-specific Reason. WORKERS is the honest choice; the justification string is
      // what Chrome Web Store review actually reads.
      reasons: ['WORKERS'],
      justification:
        'Hosts the on-device language model session used to classify feed posts locally.',
    })
    .finally(() => {
      creating = null
    })

  creating = pending
  return pending
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isRequestFor(msg, 'background')) return false

    void (async () => {
      let response: Response
      try {
        switch (msg.type) {
          case 'CLASSIFY_BATCH': {
            await ensureOffscreen()
            // TODO(002): forward to the offscreen document and return real verdicts.
            // Until the model layer exists we fail open — an empty verdict list hides nothing.
            response = { ok: true, type: 'CLASSIFY_BATCH', verdicts: [] }
            break
          }
          case 'GET_ENGINE_STATE':
            // TODO(spike S1/S2): ask the offscreen document. Until then, report honestly.
            response = { ok: true, type: 'GET_ENGINE_STATE', state: { status: 'needs_setup' } }
            break
          case 'INSTALL_MODEL':
            response = errorResponse(new Error('Model layer not implemented'))
            break
        }
      } catch (e) {
        response = errorResponse(e)
      }
      sendResponse(response)
    })()

    // MUST be a literal `true`. Promise-returning onMessage is Chrome 148+ and still rolling out
    // gradually; our floor is 138.
    return true
  })
})
