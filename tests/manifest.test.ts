import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Locks the emitted manifest to docs/architecture/technical-brief.md §2.4.
 *
 * Every permission we request widens the install warning and gives a Chrome Web Store reviewer
 * something to object to, so additions should be deliberate. If you are here because this test
 * failed, update the brief in the same commit — do not just widen the expectation.
 *
 * Requires a prior build. `pnpm verify` does build-then-test.
 */

const OUTPUTS = {
  chrome: '.output/chrome-mv3/manifest.json',
  firefox: '.output/firefox-mv3/manifest.json',
} as const

function read(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

const chrome = read(OUTPUTS.chrome)
const firefox = read(OUTPUTS.firefox)

describe.runIf(chrome)('chrome manifest', () => {
  it('is MV3', () => {
    expect(chrome!.manifest_version).toBe(3)
  })

  it('requests exactly the four justified permissions', () => {
    // 'offscreen' is deliberately absent: the Prompt API runs in the service worker (ADR-018),
    // and the offscreen document is only needed by the deferred WebLLM tier (ADR-022).
    expect(chrome!.permissions).toEqual(['storage', 'alarms', 'webNavigation', 'scripting'])
  })

  // ADR-020: access is requested during onboarding from a real user gesture, not granted at
  // install, because the July 2026 CWS user-data policy removed the exemption we relied on.
  it('has NO static host_permissions', () => {
    expect(chrome!.host_permissions).toBeUndefined()
  })

  it('requests LinkedIn as an optional host permission instead', () => {
    expect(chrome!.optional_host_permissions).toEqual(['https://www.linkedin.com/*'])
  })

  it('has NO static content_scripts — the SW registers at runtime after consent', () => {
    // WXT derives host_permissions from content-script matches, so a regression here would
    // silently reinstate the install-time grant too. The hook in wxt.config.ts strips it.
    expect(chrome!.content_scripts).toBeUndefined()
  })

  it('requests scripting, needed for runtime registration', () => {
    expect(chrome!.permissions).toContain('scripting')
  })

  it.each([
    'tabs',
    'activeTab',
    'cookies',
    'downloads',
    'unlimitedStorage',
    'offscreen',
    '<all_urls>',
  ])(
    'does not request %s',
    (perm) => {
      const all = [
        ...((chrome!.permissions as string[] | undefined) ?? []),
        ...((chrome!.host_permissions as string[] | undefined) ?? []),
        ...((chrome!.optional_host_permissions as string[] | undefined) ?? []),
      ]
      expect(all).not.toContain(perm)
    },
  )

  it('declares a Chrome floor of 138 — the Prompt API extension release', () => {
    expect(chrome!.minimum_chrome_version).toBe('138')
  })

  it('uses a service worker background', () => {
    expect(chrome!.background).toHaveProperty('service_worker')
  })
})

describe.runIf(firefox)('firefox manifest', () => {
  // WXT defaults to `manifestVersion ?? (browser === 'firefox' ? 2 : 3)`. Without the explicit
  // `manifestVersion: 3` in wxt.config.ts this silently emits MV2, and nothing else would notice.
  it('is MV3, not MV2', () => {
    expect(firefox!.manifest_version).toBe(3)
  })

  // Firefox MV3 has no service worker — bug 1775574. WXT branches to an event page.
  it('uses an event page, not a service worker', () => {
    expect(firefox!.background).toHaveProperty('scripts')
    expect(firefox!.background).not.toHaveProperty('service_worker')
  })
})

describe.skipIf(chrome && firefox)('build output', () => {
  it('is missing — run `pnpm build && pnpm build:firefox` first', () => {
    expect.fail(
      `Manifest assertions skipped: ${!chrome ? OUTPUTS.chrome : ''} ${!firefox ? OUTPUTS.firefox : ''} not found. Run \`pnpm verify\`.`,
    )
  })
})
