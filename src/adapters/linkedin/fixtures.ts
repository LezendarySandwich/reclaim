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

/**
 * The first rendered post element.
 *
 * Exists so watcher tests can mutate a post without naming a LinkedIn selector — the watcher is
 * site-agnostic and an invariant test enforces that its tests are too (ADR-004). Selector
 * knowledge belongs in `src/adapters/`, which is where this lives.
 */
export function firstPostElement(doc: Document = document): Element {
  const el = doc.querySelector('[componentkey*="FeedType_MAIN_FEED"]')
  if (!el) throw new Error('no post rendered — call renderModernFeed first')
  return el
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

/**
 * A real promoted post reported as not hiding, reduced from the captured DOM.
 *
 * Two things make it distinct from `REAL_PROMOTED_ACTOR_BLOCK`, and both were reported misses:
 *
 *  1. A *person's* follow banner ("Harsh Vardhan follows this page") sits above a *company's*
 *     promoted post, so the first `/in/` link in document order belongs to someone who is not the
 *     author. Author attribution must resolve to the company.
 *  2. The root componentkey carries `FeedType_MAIN_FEED_RELEVANCE` — the SAME FeedType as an
 *     organic post. Ads are not distinguishable by feed type, which killed a tempting shortcut.
 *
 * The real capture also nests a 13-page document carousel with its own spinners and slider; it is
 * dropped here because nothing in it bears on detection, and the element count still leaves the
 * "Promoted" label at index 14 of the scan, well inside the cap.
 */
export const REAL_FOLLOW_BANNER =
  '<h2><span>Feed post</span><span aria-hidden="true"></span></h2>' +
  // The follow banner. Its /in/ link precedes the actor block.
  '<div><a href="https://www.linkedin.com/in/harshv07/"><figure aria-hidden="true"></figure></a>' +
  '<div><p><span><a aria-label="View Harsh Vardhan’s profile" href="https://www.linkedin.com/in/harshv07/">' +
  '<strong>Harsh Vardhan</strong></a><span> </span>follows this page</span></p></div>' +
  '<button type="button" aria-label="Open control menu for post by Redpanda Data"><span></span></button></div>'

/** The company actor block. In the reported miss this painted *after* the body text. */
export const REAL_PROMOTED_COMPANY_ACTOR =
  '<div><a href="https://www.linkedin.com/company/redpanda-data/"><figure>' +
  '<img alt="View company: Redpanda Data" src="https://media.licdn.com/dms/image/redpanda_data_logo">' +
  '</figure></a><div><div><div><div>' +
  '<a href="https://www.linkedin.com/company/redpanda-data/">' +
  '<div><div aria-label="Redpanda Data Verified"><div><div><p><span>Redpanda Data</span></p></div></div>' +
  '<div><p><span><span> </span><span aria-hidden="true"></span></span></p></div></div></div></a>' +
  '</div></div><div><p><span>27,057 followers</span></p></div><div><div></div></div>' +
  '<div><p componentkey="c4aea676-7d9c-41bd-97eb-64995c6f277c"><span>Promoted</span></p></div>' +
  '</div></div>'

/** Ad copy from the same capture. Reads as ordinary marketing prose — the router clears it. */
export const REAL_AD_BODY =
  'Redpanda Streaming is designed to connect data from any source and handle any Kafka workload, ' +
  '10X faster and 6X more cost-effectively — reducing the total cost of ownership of running Kafka workloads.'

/**
 * The followed-page ad as a full post. `withLabel: false` renders the same post mid-hydration,
 * before the actor block (and so the "Promoted" label) has painted.
 */
export function followedPageAdHtml(withLabel = true): string {
  const id = 'mLWnuh6UNLNjwC9pXe5-7YigEJQ7tn5IkXokeiC0PSE'
  const key = `update-card-focus${id}FeedType_MAIN_FEED_RELEVANCE`
  // Mid-hydration, the banner and body are painted and the company actor block is not. The card
  // is already a recognisable post at that point — which is exactly why it got resolved early.
  const actor = REAL_FOLLOW_BANNER + (withLabel ? REAL_PROMOTED_COMPANY_ACTOR : '')
  return `<div componentkey="${key}" id="${key}" role="listitem">
    ${actor}
    <div data-testid="expandable-text-box"><span>${REAL_AD_BODY}</span></div>
  </div>`
}

/**
 * An image advert from a LinkedIn *showcase* page whose entire body is one emoji.
 *
 * Reported as never hiding, and unlike the previous two misses this one was unconditional rather
 * than a race. Three things about it were each individually enough to break the pipeline:
 *
 *  1. The body is a single 👇 — two characters. `pending` was derived from text length alone, so
 *     the row looked like an unpopulated lazy-mount slot and the watcher skipped it on every
 *     scan. It could never be hidden at all.
 *  2. The actor is `/showcase/aws-developers/`. Showcase pages were in neither author chain, so
 *     the author extracted as the empty string.
 *  3. The creative carries `alt="View Sponsored Content"` — LinkedIn's own accessible name for an
 *     ad, and a second structural sponsored signal that does not depend on the label hydrating.
 */
export function showcaseImageAdHtml(options: { body?: string; promotedLabel?: boolean } = {}): string {
  const id = 'AwSdEvXq11HQ67jV7JvMnQVCYS0k_6MsE4vHtxPwQQQ'
  const key = `update-card-focus${id}FeedType_MAIN_FEED_RELEVANCE`
  const label = options.promotedLabel === false
    ? ''
    : '<div><p componentkey="d57f555f"><span>Promoted</span></p></div>'
  return `<div componentkey="${key}" id="${key}" role="listitem">` +
    '<div>' +
      '<a href="https://www.linkedin.com/showcase/aws-developers/"><figure>' +
        '<img alt="View company: AWS Developers" src="https://media.licdn.com/dms/image/aws_developers_logo">' +
      '</figure></a>' +
      '<div><div><div><div>' +
        '<a href="https://www.linkedin.com/showcase/aws-developers/">' +
          '<div><div aria-label="AWS Developers "><div><div><p><span>AWS Developers</span></p></div></div></div></div>' +
        '</a>' +
      '</div></div>' +
      '<div><p><span>70,713 followers</span></p></div>' +
      label +
      '</div>' +
      '<button type="button" aria-label="Open control menu for post by AWS Developers"><span></span></button>' +
    '</div>' +
    `<p componentkey="02932678"><span data-testid="expandable-text-box">${options.body ?? '\u{1F447}'}</span></p>` +
    '<img alt="View Sponsored Content" src="https://media.licdn.com/dms/image/v2/D4E10AQE68fHE_7jq9Q/image-shrink_1280/0/1788836386598">' +
  '</div>'
}

/**
 * A human's photo post with almost no caption.
 *
 * The control for `showcaseImageAdHtml`. Letting text-light posts reach the router is only safe
 * if the router clears them, and this is the shape that would suffer if it did not: someone
 * posting a picture with a two-character caption must stay visible.
 */
export function textLightHumanPostHtml(body = '\u{1F447}'): string {
  const id = 'humanphotopostaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'.slice(0, 43)
  const key = `expanded${id}FeedType_MAIN_FEED_RELEVANCE`
  return `<div componentkey="${key}" id="${key}" role="listitem">` +
    '<div><a href="/in/dana-okafor/" aria-label="View Dana Okafor\u2019s profile">' +
      '<span aria-hidden="true">Dana Okafor</span></a></div>' +
    `<p><span data-testid="expandable-text-box">${body}</span></p>` +
    '<img alt="" src="https://media.licdn.com/dms/image/holiday-photo">' +
  '</div>'
}

/**
 * A "X commented on this" card: the commenter's profile link appears BEFORE the author's.
 *
 * Reconstructed from a real reported miss where the stub named Ivan Slater, who had commented,
 * instead of Felix Werner, who wrote the post. The leaderboard aggregates on this value, so the
 * bug credited one person's posting habits to another.
 */
export function socialContextPostHtml(options: {
  commenter?: string
  commenterSlug?: string
  author?: string
  authorSlug?: string
  body?: string
} = {}): string {
  const commenter = options.commenter ?? 'Ivan Slater'
  const commenterSlug = options.commenterSlug ?? 'ivan-slater'
  const author = options.author ?? 'Felix Werner'
  const authorSlug = options.authorSlug ?? 'felix-werner'
  const id = 'socialcontextpostaaaaaaaaaaaaaaaaaaaaaaaaaa'.slice(0, 43)
  const key = `expanded${id}FeedType_MAIN_FEED_RELEVANCE`
  return `<div componentkey="${key}" id="${key}" role="listitem">` +
    // Social-context banner. Commenter's link comes first in document order.
    `<div componentkey="social-proof-bar-key">` +
      `<a href="/in/${commenterSlug}/"><span aria-hidden="true">${commenter}</span></a>` +
      `<span> commented</span>` +
    `</div>` +
    // The post's own actor block.
    `<div>` +
      `<a href="/in/${authorSlug}/" aria-label="View ${author}’s profile">` +
        `<span aria-hidden="true">${author}</span>` +
      `</a>` +
      `<p><span>Staff Software Engineer at a video startup</span></p>` +
    `</div>` +
    `<div data-testid="expandable-text-box"><span>${options.body ?? 'Excited to announce a new role.'}</span></div>` +
  `</div>`
}
