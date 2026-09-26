/**
 * Test fixtures shaped like the real LinkedIn modern feed.
 *
 * Lives inside the adapter directory deliberately: `tests/invariants.test.ts` forbids LinkedIn
 * selectors outside `src/adapters/`, and that rule should hold for test fixtures too. Building
 * LinkedIn-shaped DOM in a watcher test would put site knowledge in a site-agnostic module — the
 * exact coupling the rule exists to prevent — and it also duplicated the fixture across two files.
 *
 * Structure mirrors what spike S4 observed on 2026-09-26:
 *  - `componentkey` on the post root, `expanded<id>FeedType_<VARIANT>`
 *  - body in `[data-testid="expandable-text-box"]` with the "… more" toggle INSIDE it
 *  - author via an `/in/` link wrapping `span[aria-hidden="true"]`
 *  - no `data-urn`, no permalink, no `<time>` element anywhere
 */

export interface PostFixture {
  /**
   * The opaque per-post id. Real ones are exactly 43 base64url characters — anything else will
   * not match `extractComponentKeyId`, which is deliberate. `padId()` normalises short test ids.
   */
  id?: string
  author?: string
  href?: string
  body?: string
  seeMore?: boolean
  socialProof?: string
  promotedLabel?: string
  media?: boolean
  variant?: 'MAIN_FEED_RELEVANCE' | 'MAIN_FEED_RECENT'
}

/** Pad a readable test id out to the real 43-char shape. */
function padId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/gu, '_')
  return cleaned.length >= 43 ? cleaned.slice(0, 43) : cleaned.padEnd(43, 'x')
}

export function modernPostHtml(options: PostFixture = {}): string {
  const id = padId(options.id ?? '7cdbt_jwDmDtd5s0G2glmqfjUhVmI_JvbKvFl2n10wQ')
  const key = `expanded${id}FeedType_${options.variant ?? 'MAIN_FEED_RELEVANCE'}`
  return `
    <div componentkey="${key}" id="${key}" role="listitem">
      <div><a href="${options.href ?? '/in/alice/'}"><span aria-hidden="true">${options.author ?? 'Alice Smith'}</span></a></div>
      ${options.promotedLabel ? `<span>${options.promotedLabel}</span>` : ''}
      <div data-testid="expandable-text-box">
        <span>${options.body ?? 'A perfectly ordinary post about shipping software.'}</span>
        ${options.seeMore ? '<button data-testid="expandable-text-button" aria-hidden="true">… more</button>' : ''}
      </div>
      ${options.media ? '<img src="https://media.licdn.com/dms/image/abc" />' : ''}
      ${options.socialProof ? `<div componentkey="social-proof-bar-key">${options.socialProof}</div>` : ''}
      <button aria-label="Open control menu">···</button>
    </div>
  `
}

/** Render a modern feed into `document`, including the `body[data-rehydrated]` profile marker. */
export function renderModernFeed(posts: string[], doc: Document = document): Document {
  doc.body.innerHTML = `<main><div data-testid="mainFeed">${posts.join('')}</div></main>`
  doc.body.setAttribute('data-rehydrated', 'true')
  return doc
}

export function renderLegacyFeed(doc: Document = document): Document {
  doc.body.innerHTML = '<div class="feed-shared-update-v2"></div>'
  doc.body.removeAttribute('data-rehydrated')
  return doc
}

export function clearFeed(doc: Document = document): void {
  doc.body.innerHTML = ''
  doc.body.removeAttribute('data-rehydrated')
}

/** Realistic sample text, so triage behaviour in watcher tests is not an artefact of lorem ipsum. */
export const SAMPLE = {
  bait:
    'Comment "GUIDE" below and I will send you the playbook. It took me six months to write ' +
    'and I am giving it away free today only, so do not miss out.',
  clean:
    'We migrated 400k rows off the legacy currency column on Tuesday. Took three weeks, mostly ' +
    'because of nulls nobody had documented anywhere. Thanks to Priya and Tom for the weekend session.',
} as const

/**
 * Real captured markup from a live Datadog advert, 2026-09-26, minified as LinkedIn serves it.
 *
 * Kept verbatim because two plausible-looking detection approaches were disproven by it: a
 * substring check (would hide promotion announcements) and a newline-split check (textContent has
 * no newlines, so it reads as "Datadog 587,644 followersPromoted"). Any future change to
 * promoted detection should be tested against this before anything hand-written.
 *
 * Note what it does NOT contain: no `sponsored-indicator-key`, no `data-sponsored-tracking-url`,
 * no `data-view-tracking-scope`. The componentkeys are opaque UUIDs.
 */
export const REAL_PROMOTED_ACTOR_BLOCK =
  '<a href="https://www.linkedin.com/company/datadog/" componentkey="40fd94e3">' +
  '<figure componentkey="40fd94e3">' +
  '<img alt="View company: Datadog" src="https://media.licdn.com/dms/image/datadog_logo">' +
  '</figure></a>' +
  '<div>' +
  '<a href="https://www.linkedin.com/company/datadog/" componentkey="77a3aba0">' +
  '<div aria-label="Datadog Verified"><p><span>Datadog</span></p></div>' +
  '</a>' +
  '<div><p><span>587,644 followers</span></p></div>' +
  '<div><p componentkey="4f2424c1-c53e-4c8f-9c63-172e339627d9"><span>Promoted</span></p></div>' +
  '</div>'

/** A promoted post built from the real actor block plus ad copy. */
export function realPromotedPostHtml(body: string): string {
  const id = '9xKpQr2MdnVkMoPnH_c9l5ga0mViyAynFjul67OW'.padEnd(43, 'z')
  const key = `expanded${id}FeedType_MAIN_FEED_RELEVANCE`
  return `<div componentkey="${key}" id="${key}" role="listitem">
    ${REAL_PROMOTED_ACTOR_BLOCK}
    <div data-testid="expandable-text-box"><span>${body}</span></div>
  </div>`
}
