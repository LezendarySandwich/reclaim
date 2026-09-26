import { execSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * Codebase-wide invariant guards.
 *
 * These are the product commitments that a well-meaning change could quietly break without any
 * unit test noticing, because nothing about them is local to one module.
 */

function grepSrc(pattern: string): string[] {
  try {
    return execSync(`grep -rn --include=*.ts --include=*.tsx -- '${pattern}' src/`, {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch {
    return [] // grep exits 1 when there are no matches
  }
}

describe('ADR-014 — chrome.storage.sync is banned', () => {
  it('appears nowhere in src/', () => {
    // storage.sync uploads to Google's servers, which would make the on-device guarantee false.
    const hits = grepSrc('storage\\.sync').filter((l) => !l.includes('BANNED'))
    expect(hits).toEqual([])
  })
})

describe('ADR-021 — zero network requests to linkedin.com', () => {
  it('src/ contains no fetch or XHR to linkedin', () => {
    const hits = [
      ...grepSrc('fetch(.*linkedin'),
      ...grepSrc('XMLHttpRequest'),
      ...grepSrc('voyager'),
    ].filter((l) => !l.includes('ADR-021') && !l.includes('never'))
    expect(hits).toEqual([])
  })
})

describe('ADR-004 — site selectors live only in adapters', () => {
  it('no LinkedIn-specific selector leaks outside src/adapters/', () => {
    const hits = [
      ...grepSrc('feed-shared-update'),
      ...grepSrc('componentkey'),
      ...grepSrc('data-testid="mainFeed"'),
    ].filter((l) => !l.startsWith('src/adapters/'))
    expect(hits).toEqual([])
  })
})

/** Line content with the `path:lineno:` prefix stripped. */
function body(grepLine: string): string {
  return grepLine.replace(/^[^:]+:\d+:/, '')
}

/** A comment, not code. The rule-declaring doc comments would otherwise trip their own guards. */
function isComment(grepLine: string): boolean {
  return /^\s*(?:\/\/|\/\*|\*)/.test(body(grepLine))
}

describe('src/core and src/detect stay platform-free', () => {
  it('contain no chrome.* or browser.* calls', () => {
    // These modules must be unit-testable in plain node, which is what keeps the detection logic
    // honest — it cannot quietly start depending on browser state.
    const hits = execSync(
      `grep -rn --include=*.ts -e 'chrome\\.' -e "from 'wxt/browser'" src/core src/detect || true`,
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((l) => !isComment(l))
    expect(hits).toEqual([])
  })
})
