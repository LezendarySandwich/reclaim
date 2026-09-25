import { fakeBrowser } from 'wxt/testing/fake-browser'
import { beforeEach } from 'vitest'

// happy-dom and jsdom both lack these. Polyfill here rather than in source, so production code
// is not written against a shim that does not exist in a real browser.
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
}

if (typeof globalThis.requestIdleCallback !== 'function') {
  globalThis.requestIdleCallback = ((cb: IdleRequestCallback) =>
    setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0) as unknown as number) as typeof globalThis.requestIdleCallback
  globalThis.cancelIdleCallback = ((id: number) => clearTimeout(id)) as typeof globalThis.cancelIdleCallback
}

// Neither test DOM does layout — every element reports a 0x0 rect. Any assertion that depends on
// geometry (viewport proximity, stub height, scroll position) belongs in Playwright, not here.

beforeEach(() => {
  fakeBrowser.reset()
})
