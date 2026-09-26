import { describe, expect, it } from 'vitest'
import { buildVerdictKey, hashText, isStale, normalizeForHash, verdictCacheKey } from './cache'

const base = { postId: 'p1', text: 'hello world', rulesVersion: 'r1', engineId: 'e1' }

describe('hashText', () => {
  it('is deterministic', () => {
    expect(hashText('hello')).toBe(hashText('hello'))
  })

  it('distinguishes different inputs', () => {
    expect(hashText('hello')).not.toBe(hashText('hellp'))
  })

  it('handles empty string without throwing', () => {
    expect(typeof hashText('')).toBe('string')
  })

  it.each([
    ['emoji', '🚀 Thrilled to announce 🎉'],
    ['CJK', '很高兴宣布我加入了新公司'],
    ['RTL arabic', 'يسعدني أن أعلن'],
    ['combining marks', 'égalité'],
    ['surrogate pair', '𝕳𝖊𝖑𝖑𝖔'],
    ['zero-width joiner', '👨‍👩‍👧‍👦'],
  ])('handles %s without throwing', (_label, text) => {
    expect(() => hashText(text)).not.toThrow()
    expect(hashText(text)).toBe(hashText(text))
  })

  it('does not collide across a large set of realistic post texts', () => {
    // Not a cryptographic guarantee — just evidence the function actually spreads. A collision in
    // 5000 short strings would mean the hash is broken, not unlucky.
    const seen = new Set<string>()
    for (let i = 0; i < 5000; i++) {
      seen.add(hashText(`Thrilled to announce that I am joining company number ${i} as a leader.`))
    }
    expect(seen.size).toBe(5000)
    for (let i = 0; i < 5000; i++) seen.add(hashText(`🚀 ${i} lessons I learned the hard way`))
    expect(seen.size).toBe(10000)
  })

  it('stays fast enough for the scroll path', () => {
    const text = 'word '.repeat(400)
    const start = performance.now()
    for (let i = 0; i < 1000; i++) hashText(text)
    // 1000 x 2000-char hashes. Generous ceiling — this is a smoke alarm for an accidental
    // quadratic, not a benchmark.
    expect(performance.now() - start).toBeLessThan(500)
  })
})

describe('normalizeForHash', () => {
  it('collapses whitespace runs and trims', () => {
    expect(normalizeForHash('  a\n\n  b\t c  ')).toBe('a b c')
  })

  it('makes cosmetically-identical posts share a hash', () => {
    expect(hashText(normalizeForHash('hello\n\nworld'))).toBe(
      hashText(normalizeForHash('  hello world  ')),
    )
  })

  it('preserves case, because casing is a real triage signal', () => {
    expect(normalizeForHash('Hello World')).not.toBe(normalizeForHash('hello world'))
  })
})

describe('verdictCacheKey', () => {
  it('is stable for identical inputs', () => {
    expect(verdictCacheKey(buildVerdictKey(base))).toBe(verdictCacheKey(buildVerdictKey(base)))
  })

  it.each(['postId', 'text', 'rulesVersion', 'engineId'] as const)(
    'changes when %s changes — this is what makes invalidation automatic',
    (field) => {
      const changed = { ...base, [field]: `${base[field]}-different` }
      expect(verdictCacheKey(buildVerdictKey(changed))).not.toBe(
        verdictCacheKey(buildVerdictKey(base)),
      )
    },
  )

  it('cannot be forged by moving a separator between components', () => {
    // Without a non-printable separator, {postId:'a:b', textHash:'c'} and
    // {postId:'a', textHash:'b:c'} would produce the same key.
    const a = verdictCacheKey({ postId: 'a:b', textHash: 'c', rulesVersion: 'r', engineId: 'e' })
    const b = verdictCacheKey({ postId: 'a', textHash: 'b:c', rulesVersion: 'r', engineId: 'e' })
    expect(a).not.toBe(b)
  })
})

describe('isStale', () => {
  it('is false when rules and engine both match', () => {
    expect(isStale({ rulesVersion: 'r1', engineId: 'e1' }, 'r1', 'e1')).toBe(false)
  })

  it('is true when the rules version moved — shipping new heuristics invalidates everything', () => {
    expect(isStale({ rulesVersion: 'r1', engineId: 'e1' }, 'r2', 'e1')).toBe(true)
  })

  it('is true when the user switched model', () => {
    expect(isStale({ rulesVersion: 'r1', engineId: 'gemini-nano' }, 'r1', 'qwen3-0.6b')).toBe(true)
  })
})
