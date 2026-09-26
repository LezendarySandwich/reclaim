import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STUB_ATTR, hasStub, mountStub, unmountStub } from './stub'

function makePost(): HTMLElement {
  document.body.innerHTML = ''
  const post = document.createElement('article')
  post.innerHTML = `
    <header><a href="/in/alice">Alice</a></header>
    <div class="body">Some post text</div>
    <footer><button id="like">Like</button></footer>
  `
  document.body.append(post)
  return post
}

const opts = (over: Partial<Parameters<typeof mountStub>[1]> = {}) => ({
  label: 'Looks like engagement bait',
  authorName: 'Alice',
  onExpand: vi.fn(),
  ...over,
})

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('collapsing', () => {
  it('hides the post content but keeps the row in the layout flow', () => {
    // Load-bearing: display:none on the row starves LinkedIn's IntersectionObserver sentinel and
    // infinite scroll silently stops.
    const post = makePost()
    mountStub(post, opts())
    expect(post.style.display).not.toBe('none')
    expect(post.querySelector('header')).toHaveProperty('style.display', 'none')
    expect(post.querySelector('.body')).toHaveProperty('style.display', 'none')
  })

  it('appends a stub host', () => {
    const post = makePost()
    mountStub(post, opts())
    expect(hasStub(post)).toBe(true)
  })

  it('renders inside a shadow root, so LinkedIn CSS cannot reach it', () => {
    const post = makePost()
    const { host } = mountStub(post, opts())
    expect(host.shadowRoot).not.toBeNull()
    expect(host.shadowRoot!.querySelector('.bar')).not.toBeNull()
  })

  it('shows the author and the reason', () => {
    const post = makePost()
    const { host } = mountStub(post, opts())
    const text = host.shadowRoot!.textContent ?? ''
    expect(text).toContain('Alice')
    expect(text).toContain('Looks like engagement bait')
  })

  it('never renders a number (ADR-019 forbids a confidence score)', () => {
    const post = makePost()
    const { host } = mountStub(post, opts({ label: 'Looks templated' }))
    // The visible bar only — shadowRoot.textContent would include the stylesheet, which is full
    // of perfectly legitimate numbers.
    const visible = host.shadowRoot!.querySelector('.bar')!.textContent ?? ''
    expect(visible).not.toMatch(/\d/)
    expect(visible).toContain('Looks templated')
  })

  it('does not stack stubs when mounted twice on a recycled node', () => {
    const post = makePost()
    mountStub(post, opts())
    mountStub(post, opts())
    expect(post.querySelectorAll(`[${STUB_ATTR}]`)).toHaveLength(1)
  })
})

describe('expanding', () => {
  it('restores the original content', () => {
    const post = makePost()
    mountStub(post, opts())
    const button = post.querySelector(`[${STUB_ATTR}]`)!.shadowRoot!.querySelector('button')!
    button.click()
    expect(post.querySelector('.body')).toHaveProperty('style.display', '')
    expect(hasStub(post)).toBe(false)
  })

  it('calls onExpand', () => {
    const post = makePost()
    const onExpand = vi.fn()
    mountStub(post, opts({ onExpand }))
    post.querySelector(`[${STUB_ATTR}]`)!.shadowRoot!.querySelector('button')!.click()
    expect(onExpand).toHaveBeenCalledOnce()
  })

  it('restores a display value the page had set explicitly', () => {
    const post = makePost()
    const body = post.querySelector('.body') as HTMLElement
    body.style.display = 'flex'
    mountStub(post, opts())
    expect(body.style.display).toBe('none')
    post.querySelector(`[${STUB_ATTR}]`)!.shadowRoot!.querySelector('button')!.click()
    expect(body.style.display).toBe('flex')
  })
})

describe('accessibility', () => {
  it('gives the Show button a name that means something out of context', () => {
    // Screen-reader users navigate by button list, where a bare "Show" is useless.
    const post = makePost()
    const { host } = mountStub(post, opts())
    const button = host.shadowRoot!.querySelector('button')!
    expect(button.getAttribute('aria-label')).toBe('Show hidden post from Alice')
  })

  it('marks the collapsed state with aria-expanded', () => {
    const post = makePost()
    const { host } = mountStub(post, opts())
    expect(host.shadowRoot!.querySelector('button')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('does NOT use aria-controls, which cannot cross a shadow boundary', () => {
    const post = makePost()
    const { host } = mountStub(post, opts())
    expect(host.shadowRoot!.querySelector('button')!.hasAttribute('aria-controls')).toBe(false)
  })

  it('does NOT add a live region', () => {
    // A scroll burst collapses a dozen posts and would queue a dozen announcements over whatever
    // the user was reading. Silence until debouncing is designed.
    const post = makePost()
    const { host } = mountStub(post, opts())
    expect(host.shadowRoot!.querySelector('[aria-live]')).toBeNull()
  })

  it('moves focus to the stub when focus was inside the hidden content', () => {
    const post = makePost()
    const like = post.querySelector('#like') as HTMLButtonElement
    like.focus()
    expect(post.contains(document.activeElement)).toBe(true)
    const { host } = mountStub(post, opts())
    expect(host.shadowRoot!.activeElement).toBe(host.shadowRoot!.querySelector('button'))
  })

  it('does NOT steal focus when focus was elsewhere', () => {
    // Posts collapse as you scroll. Yanking focus each time would be unusable.
    const outside = document.createElement('input')
    document.body.append(outside)
    const post = makePost()
    document.body.append(outside)
    outside.focus()
    mountStub(post, opts())
    expect(document.activeElement).toBe(outside)
  })

  it('uses em-based sizing so user font scaling still works', () => {
    // WXT's createShadowRootUi injects `all: initial`, which severs rem inheritance. We do not
    // use it, and this asserts we have not quietly reintroduced a fixed-pixel layout.
    const post = makePost()
    const { host } = mountStub(post, opts())
    // Strip comments first: the stylesheet explains *why* it avoids `all: initial`, and that
    // explanation would otherwise trip the assertion it is explaining.
    const css = (host.shadowRoot!.querySelector('style')!.textContent ?? '').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    expect(css).not.toMatch(/all:\s*initial/)
    expect(css).toMatch(/min-height:\s*2\.75em/)
    // No fixed pixel sizes on anything that should scale with the user's font size.
    expect(css).not.toMatch(/(?:min-height|font-size|padding):[^;]*\d+px/)
  })

  it('uses system colour keywords so forced-colors mode adapts', () => {
    const post = makePost()
    const { host } = mountStub(post, opts())
    const css = host.shadowRoot!.querySelector('style')!.textContent ?? ''
    expect(css).toContain('CanvasText')
    expect(css).toContain('forced-colors')
  })
})

describe('feedback control', () => {
  it('is absent unless a handler is supplied', () => {
    const post = makePost()
    const { host } = mountStub(post, opts())
    expect(host.shadowRoot!.querySelectorAll('button')).toHaveLength(1)
  })

  it('calls onDisagree', () => {
    const post = makePost()
    const onDisagree = vi.fn()
    const { host } = mountStub(post, opts({ onDisagree }))
    const buttons = [...host.shadowRoot!.querySelectorAll('button')]
    buttons.find((b) => b.textContent === 'Not slop')!.click()
    expect(onDisagree).toHaveBeenCalledOnce()
  })
})

describe('unmountStub', () => {
  it('removes a stale stub and restores content — needed for recycled nodes', () => {
    const post = makePost()
    mountStub(post, opts())
    unmountStub(post)
    expect(hasStub(post)).toBe(false)
    expect(post.querySelector('.body')).toHaveProperty('style.display', '')
  })

  it('is safe on a post that was never collapsed', () => {
    expect(() => unmountStub(makePost())).not.toThrow()
  })
})
