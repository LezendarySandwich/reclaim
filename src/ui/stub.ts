/**
 * The collapsed stub.
 *
 * The most-rendered surface in the product, and the one with the most unresearched accessibility
 * risk (technical-brief §10 R13). Kept in one module with no other responsibility so that risk
 * stays contained and reviewable.
 *
 * ## Deliberate choices, each with a reason
 *
 * **Shadow root, but NOT `all: initial`.** WXT's `createShadowRootUi` prepends
 * `:host { all: initial !important }`, which is suspected to defeat forced-colors / high-contrast
 * adaptation and to sever `rem`-based user font scaling. Both would make the stub inaccessible in
 * exactly the situations where accessibility matters most, so we scope styles ourselves and use
 * system colours that respond to forced-colors.
 *
 * **No `aria-live`.** Tempting — "post hidden" feels like something to announce — but a scroll
 * burst collapses a dozen posts at once and would queue a dozen announcements over whatever the
 * user was actually reading. Until that debouncing is designed, silence is the accessible choice.
 * The stub is in the document and reachable; it does not need to shout.
 *
 * **No `aria-controls`.** IDREFs do not cross shadow-root boundaries, so it would be a dangling
 * reference that some screen readers report as broken. `aria-expanded` on the button carries the
 * meaning without lying about structure.
 *
 * **Never renders a score.** ADR-019: detectors are badly calibrated out of distribution, and a
 * percentage implies a precision we have not measured and cannot support.
 */

export interface StubOptions {
  /** e.g. "Looks like engagement bait". Never a score, never an authorship claim. */
  label: string
  authorName: string
  onExpand: () => void
  /** Feedback — "you got this wrong". Omit to hide the control. */
  onDisagree?: () => void
}

export const STUB_ATTR = 'data-reclaim-stub'

const STYLES = `
:host {
  /* Deliberately NOT \`all: initial\`. We reset only what LinkedIn is likely to inherit into us,
     so forced-colors and the user's font scaling both keep working. */
  display: block;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 0.875rem;
  line-height: 1.4;
  color: CanvasText;
}
.bar {
  display: flex;
  align-items: center;
  gap: 0.5em;
  padding: 0.75em 1em;
  background: Canvas;
  border: 1px solid ButtonBorder;
  border-radius: 0.5em;
  /* Minimum, not fixed: the row must be able to grow when text is scaled up. */
  min-height: 2.75em;
  box-sizing: border-box;
}
.label { flex: 1 1 auto; min-width: 0; }
.author { font-weight: 600; }
.reason { opacity: 0.8; }
button {
  font: inherit;
  color: LinkText;
  background: none;
  border: 1px solid transparent;
  border-radius: 0.25em;
  /* 44px at default font size — pointer target guidance, expressed in em so it scales. */
  min-height: 2.75em;
  min-width: 2.75em;
  padding: 0 0.75em;
  cursor: pointer;
  flex: 0 0 auto;
}
button:hover { text-decoration: underline; }
button:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
@media (prefers-reduced-motion: no-preference) {
  .bar { transition: background-color 120ms ease; }
}
@media (forced-colors: active) {
  /* Transparent borders vanish in forced-colors, so give the focus ring something real. */
  button { border-color: ButtonBorder; }
}
`

interface MountedStub {
  host: HTMLElement
  /** Restores the original content. Safe to call more than once. */
  remove: () => void
}

/**
 * Collapse `target`, hiding its children behind a stub.
 *
 * Does NOT set `display: none` on the target itself — LinkedIn's infinite scroll is driven by an
 * IntersectionObserver sentinel, and removing rows from the layout flow starves it, so the feed
 * silently stops loading. Two independent prior-art projects documented hitting exactly this. We
 * keep the row in flow and hide only its contents.
 */
export function mountStub(target: HTMLElement, options: StubOptions): MountedStub {
  const existing = target.querySelector(`[${STUB_ATTR}]`)
  if (existing) {
    // Already collapsed. Re-mounting would stack stubs on a recycled node.
    return { host: existing as HTMLElement, remove: () => {} }
  }

  // Remember whether focus was inside the post we are about to hide. If it was, leaving it there
  // would strand the user on an element that is no longer visible — a classic screen-reader trap.
  const hadFocus = target.contains(document.activeElement)

  const hidden: Array<{ el: HTMLElement; prev: string }> = []
  for (const child of Array.from(target.children)) {
    if (!(child instanceof HTMLElement)) continue
    hidden.push({ el: child, prev: child.style.display })
    child.style.display = 'none'
  }

  const host = document.createElement('div')
  host.setAttribute(STUB_ATTR, '')
  const shadow = host.attachShadow({ mode: 'open' })

  const style = document.createElement('style')
  style.textContent = STYLES
  shadow.append(style)

  const bar = document.createElement('div')
  bar.className = 'bar'

  const label = document.createElement('span')
  label.className = 'label'
  const author = document.createElement('span')
  author.className = 'author'
  author.textContent = options.authorName
  const reason = document.createElement('span')
  reason.className = 'reason'
  reason.textContent = ` — ${options.label}`
  label.append(author, reason)

  const show = document.createElement('button')
  show.type = 'button'
  show.textContent = 'Show'
  // A bare "Show" is meaningless out of context, and screen-reader users routinely navigate by
  // button list.
  show.setAttribute('aria-label', `Show hidden post from ${options.authorName}`)
  show.setAttribute('aria-expanded', 'false')

  bar.append(label, show)

  if (options.onDisagree) {
    const wrong = document.createElement('button')
    wrong.type = 'button'
    wrong.textContent = 'Not slop'
    wrong.setAttribute('aria-label', `Report that this post from ${options.authorName} was hidden wrongly`)
    wrong.addEventListener('click', () => options.onDisagree?.())
    bar.append(wrong)
  }

  shadow.append(bar)

  const restore = (): void => {
    for (const { el, prev } of hidden) el.style.display = prev
    host.remove()
  }

  show.addEventListener('click', () => {
    restore()
    options.onExpand()
  })

  target.append(host)

  // Move focus to the stub only if it was inside the content we just hid. Stealing focus
  // otherwise would yank the user out of whatever they were doing as posts collapse around them.
  if (hadFocus) show.focus()

  return { host, remove: restore }
}

/** True when this element already carries a stub. Cheap enough for the scroll path. */
export function hasStub(target: Element): boolean {
  return target.querySelector(`[${STUB_ATTR}]`) !== null
}

/**
 * Remove a stub and restore the post.
 *
 * Needed for recycled DOM nodes: if LinkedIn reuses a row for a different post, a stale stub must
 * come off before the new content is judged. Safe on an element that was never collapsed.
 */
export function unmountStub(target: HTMLElement): void {
  const host = target.querySelector(`[${STUB_ATTR}]`)
  if (!host) return
  host.remove()
  for (const child of Array.from(target.children)) {
    if (child instanceof HTMLElement && child.style.display === 'none') {
      child.style.display = ''
    }
  }
}
