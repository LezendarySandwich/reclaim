import { describe, expect, it } from 'vitest'
import { EMPTY_FEATURES, extractFeatures } from './features'

describe('extractFeatures — shape', () => {
  it('returns all-zero features for empty input', () => {
    expect(extractFeatures('')).toEqual(EMPTY_FEATURES)
    expect(extractFeatures('   \n\t ')).toEqual(EMPTY_FEATURES)
  })

  it('keeps every feature except wordCount within 0-1', () => {
    const samples = [
      '🚀 STOP scrolling. Comment "GUIDE" below and I will send it.',
      'a'.repeat(2000),
      'Not just one — but two, three, and four. It is not X. It is Y. '.repeat(30),
      '很高兴宣布我加入了新公司。'.repeat(30),
    ]
    for (const s of samples) {
      const f = extractFeatures(s)
      for (const [key, value] of Object.entries(f)) {
        if (key === 'wordCount') continue
        expect(value, `${key} on ${s.slice(0, 24)}`).toBeGreaterThanOrEqual(0)
        expect(value, `${key} on ${s.slice(0, 24)}`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('abstractness is the exact complement of concreteness', () => {
    const f = extractFeatures('We shipped 3 fixes to the Stripe webhook handler on Tuesday.')
    expect(f.abstractness).toBeCloseTo(1 - f.concreteness, 10)
  })
})

describe('antithesis — the construction the first regex missed entirely', () => {
  it.each([
    'Leadership is not about having answers. It is about asking questions.',
    "It's not a job. It's a calling.",
    'This is not just a product, but a movement.',
    'Success is not luck, it is preparation.',
  ])('detects %s', (text) => {
    expect(extractFeatures(`${text} `.repeat(3)).antithesisRate).toBeGreaterThan(0)
  })

  it('does not fire on ordinary negation', () => {
    const f = extractFeatures(
      'I did not attend the conference because my flight was cancelled on Tuesday morning.',
    )
    expect(f.antithesisRate).toBe(0)
  })
})

describe('tricolon — phrasal, not just single words', () => {
  it('detects a phrasal rule of three', () => {
    const f = extractFeatures(
      'They listen more than they speak, they give credit generously, and they take responsibility.',
    )
    expect(f.tricolonRate).toBeGreaterThan(0)
  })

  it('detects the single-word form too', () => {
    expect(extractFeatures('We made it faster, cheaper, and better.').tricolonRate).toBeGreaterThan(0)
  })

  it('does not fire on a two-item list', () => {
    expect(extractFeatures('We made it faster and cheaper.').tricolonRate).toBe(0)
  })
})

describe('engagement-bait markers', () => {
  it('detects a comment gate', () => {
    expect(
      extractFeatures('Comment "GUIDE" below and I will send you the playbook.').commentGate,
    ).toBe(1)
  })

  it('does not fire on an ordinary request to comment', () => {
    expect(extractFeatures('Let me know what you think in the comments.').commentGate).toBe(0)
  })

  it('detects a question closer only at the end', () => {
    expect(extractFeatures('Some thoughts on hiring.\n\nAgree?').questionCloser).toBe(1)
    expect(extractFeatures('Agree? Well, here is a long post about hiring.').questionCloser).toBe(0)
  })

  it('detects the time-contrast arc', () => {
    expect(
      extractFeatures('5 years ago I was broke and sleeping on a sofa. Today I run a agency.')
        .timeContrast,
    ).toBe(1)
  })

  it('detects emoji bullets', () => {
    const f = extractFeatures('🚀 One\n💡 Two\n🔥 Three\n✅ Four')
    expect(f.emojiBulletRate).toBeGreaterThan(0.9)
  })
})

describe('uniformity', () => {
  it('scores uniform sentence lengths high', () => {
    const uniform = 'This is a sentence here. This is a sentence here. This is a sentence here. This is a sentence here.'
    expect(extractFeatures(uniform).sentenceUniformity).toBeGreaterThan(0.8)
  })

  it('scores bursty human rhythm low', () => {
    const bursty =
      'Yes. I spent eleven hours yesterday chasing a bug that turned out to be a trailing newline in a config file nobody had touched since 2019. Brutal. Fixed now.'
    expect(extractFeatures(bursty).sentenceUniformity).toBeLessThan(0.5)
  })

  it('returns 0 rather than a spurious value for fewer than three sentences', () => {
    expect(extractFeatures('One sentence only here.').sentenceUniformity).toBe(0)
  })
})

describe('robustness', () => {
  it.each([
    ['5000 words', 'word '.repeat(5000)],
    ['no spaces', 'x'.repeat(5000)],
    ['adversarial antithesis repetition', 'is not a, it is b. '.repeat(500)],
    ['adversarial comma lists', 'a, b, and c, '.repeat(500)],
    ['emoji only', '🚀'.repeat(500)],
    ['mixed RTL', 'يسعدني أن أعلن hello world '.repeat(100)],
  ])('handles %s without throwing or hanging', (_label, text) => {
    const start = performance.now()
    expect(() => extractFeatures(text)).not.toThrow()
    expect(performance.now() - start).toBeLessThan(500)
  })

  it('is stable across repeated calls — module-level /g regexes do not leak lastIndex', () => {
    const text = 'It is not X. It is Y. We made it faster, cheaper, and better.'
    const first = extractFeatures(text)
    for (let i = 0; i < 5; i++) {
      expect(extractFeatures(text)).toEqual(first)
    }
  })
})
