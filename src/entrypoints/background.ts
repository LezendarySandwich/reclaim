import { browser } from 'wxt/browser'
import { errorResponse, isRequestFor } from '../core/messages'
import type { Response } from '../core/messages'
import { gateState, mayReadPosts } from '../core/consent'
import { hasConsent } from '../storage/settings'

/**
 * Service worker — router, consent gate, and (later) the Prompt API host.
 *
 * ADR-018 reversed the original plan: `LanguageModel` IS available here. Chromium force-enables
 * `AIPromptAPIForWorkers` for any renderer launched with `--extension-process`, and the
 * user-gesture check is skipped entirely when there is no Window — so this is the privileged
 * context for the Prompt API, and an offscreen document (a Window that can never obtain user
 * activation) is the handicapped one. The offscreen document is kept for WebLLM only.
 *
 * Still no IndexedDB here: the offscreen document outlives this worker, so it owns writes.
 */

const CONTENT_SCRIPT_ID = 'linkedin-feed'
const LINKEDIN_ORIGIN = 'https://www.linkedin.com/*'
const LINKEDIN_FEED_MATCH = 'https://www.linkedin.com/feed/*'

const OFFSCREEN_PATH = '/offscreen.html'

let creating: Promise<void> | null = null

/** Race-free. Only one offscreen document may exist, and concurrent callers will both try. */
async function ensureOffscreen(): Promise<void> {
  const existing = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [browser.runtime.getURL(OFFSCREEN_PATH)],
  })
  if (existing.length > 0) return
  if (creating) return creating

  const pending = browser.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
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

async function hasHostPermission(): Promise<boolean> {
  return browser.permissions.contains({ origins: [LINKEDIN_ORIGIN] })
}

/**
 * Bring the registered content script in line with the gate.
 *
 * Reconciles rather than blindly registering: MV3 runtime registrations persist across browser
 * restarts, so calling `registerContentScripts` again on startup throws a duplicate-id error.
 * Idempotent by construction — safe to call from any event.
 */
async function reconcileContentScript(): Promise<void> {
  const state = gateState({
    hasConsent: await hasConsent(),
    hasHostPermission: await hasHostPermission(),
  })

  const registered = await browser.scripting.getRegisteredContentScripts({
    ids: [CONTENT_SCRIPT_ID],
  })
  const isRegistered = registered.length > 0

  if (mayReadPosts(state)) {
    if (isRegistered) return
    await browser.scripting.registerContentScripts([
      {
        id: CONTENT_SCRIPT_ID,
        matches: [LINKEDIN_FEED_MATCH],
        js: ['content-scripts/linkedin.js'],
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
    ])
    return
  }

  if (isRegistered) {
    await browser.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] })
  }
}

export default defineBackground(() => {
  // Reconcile on every lifecycle event that could change either condition. Cheap, and much more
  // reliable than trying to enumerate the ways consent or a permission can change.
  browser.runtime.onInstalled.addListener(() => void reconcileContentScript())
  browser.runtime.onStartup.addListener(() => void reconcileContentScript())
  browser.permissions.onAdded.addListener(() => void reconcileContentScript())
  browser.permissions.onRemoved.addListener(() => void reconcileContentScript())
  void reconcileContentScript()

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isRequestFor(msg, 'background')) return false

    void (async () => {
      let response: Response
      try {
        switch (msg.type) {
          case 'CLASSIFY_BATCH': {
            // Defence in depth. The content script should not be running at all without consent,
            // but a stale registration or a racing revoke must not result in a classification.
            const state = gateState({
              hasConsent: await hasConsent(),
              hasHostPermission: await hasHostPermission(),
            })
            if (!mayReadPosts(state)) {
              response = errorResponse(new Error(`Consent gate is ${state.status}`))
              break
            }
            await ensureOffscreen()
            // TODO(007): run the engine. Until it exists we fail open — an empty verdict list
            // hides nothing.
            response = { ok: true, type: 'CLASSIFY_BATCH', verdicts: [] }
            break
          }
          case 'GET_ENGINE_STATE': {
            const state = gateState({
              hasConsent: await hasConsent(),
              hasHostPermission: await hasHostPermission(),
            })
            response = {
              ok: true,
              type: 'GET_ENGINE_STATE',
              state: mayReadPosts(state) ? { status: 'needs_setup' } : { status: 'uninitialized' },
            }
            break
          }
          case 'INSTALL_MODEL':
            response = errorResponse(new Error('Model layer not implemented'))
            break
        }
      } catch (e) {
        response = errorResponse(e)
      }
      sendResponse(response)
    })()

    // MUST be a literal `true`. Promise-returning onMessage is Chrome 148+ and our floor is 138.
    return true
  })
})
