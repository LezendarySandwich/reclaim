/**
 * Settings persistence.
 *
 * `chrome.storage.local` only. `chrome.storage.sync` is BANNED (ADR-014) — it uploads to Google's
 * servers, which would make the on-device guarantee false. A test greps the codebase for it.
 */

import { browser } from 'wxt/browser'
import { DEFAULT_SETTINGS } from '../core/types'
import type { Settings } from '../core/types'

const KEY = 'settings'

/** Merges over defaults so a settings object written by an older version still loads. */
export async function loadSettings(): Promise<Settings> {
  const got = await browser.storage.local.get(KEY)
  const stored = got[KEY] as Partial<Settings> | undefined
  if (!stored) return structuredClone(DEFAULT_SETTINGS)
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...stored,
    axes: { ...structuredClone(DEFAULT_SETTINGS.axes), ...(stored.axes ?? {}) },
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.local.set({ [KEY]: settings })
}

/** Has the user given the consent required before any post text may be read? (ADR-020) */
const CONSENT_KEY = 'consentGrantedAt'

export async function hasConsent(): Promise<boolean> {
  const got = await browser.storage.local.get(CONSENT_KEY)
  return typeof got[CONSENT_KEY] === 'number'
}

export async function grantConsent(at: number): Promise<void> {
  await browser.storage.local.set({ [CONSENT_KEY]: at })
}

export async function revokeConsent(): Promise<void> {
  await browser.storage.local.remove(CONSENT_KEY)
}
