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

describe('emoji — the LinkedIn slop vocabulary', () => {
  it('detects the rocket-lightbulb-tick listicle shape', () => {
    const f = extractFeatures('🚀 Ship fast\n💡 Learn faster\n✅ Repeat\n🔥 Win')
    expect(f.slopEmojiRate).toBeGreaterThan(0.9)
    expect(f.emojiBulletRate).toBeGreaterThan(0.9)
  })

  it('detects 👉 used as a bullet glyph', () => {
    const f = extractFeatures('Three lessons:\n👉 One thing\n👉 Another thing\n👉 A third thing')
    expect(f.slopEmojiRate).toBeGreaterThan(0.5)
    expect(f.emojiBulletRate).toBeGreaterThan(0.5)
  })

  it('counts slop emoji anywhere, not only at line starts', () => {
    const f = extractFeatures(
      'We shipped it 🚀 and the team was thrilled 🔥 and the metrics went up 📈 massively 💯',
    )
    expect(f.slopEmojiRate).toBeGreaterThan(0)
    expect(f.emojiBulletRate).toBe(0)
  })

  it('separates raw density from the slop vocabulary', () => {
    // Plenty of people use emoji. Using THESE emoji is the signal, not emoji as such.
    const ordinary = extractFeatures('Had a great weekend with the family 😊🐕🌳 lovely weather ☀️')
    expect(ordinary.emojiDensity).toBeGreaterThan(0)
    expect(ordinary.slopEmojiRate).toBe(0)
  })

  it('matches both the bare and variation-selector forms of an emoji', () => {
    expect(extractFeatures('➡️ one\n➡️ two\n➡️ three').slopEmojiRate).toBeGreaterThan(0)
    expect(extractFeatures('➡ one\n➡ two\n➡ three').slopEmojiRate).toBeGreaterThan(0)
  })

  it('handles a leading-whitespace emoji bullet, which the slice(0,3) version missed', () => {
    expect(extractFeatures('  🚀 One\n  💡 Two\n  ✅ Three').emojiBulletRate).toBeGreaterThan(0.9)
  })

  it('does not slice a surrogate pair in half', () => {
    expect(() => extractFeatures('🚀')).not.toThrow()
    expect(extractFeatures('🚀 a\n🚀 b\n🚀 c').emojiBulletRate).toBeGreaterThan(0.9)
  })

  it('scores a plain text post at zero on all three', () => {
    const f = extractFeatures('We fixed the reconciliation bug on Tuesday. It took four hours.')
    expect(f.emojiDensity).toBe(0)
    expect(f.slopEmojiRate).toBe(0)
    expect(f.emojiBulletRate).toBe(0)
  })
})

describe('the label-listicle shape (two real missed posts)', () => {
  // Both misses were built entirely from `Term: description` lines and the module was blind to
  // it. One routed `clean` and never reached the model at all.
  it('detects a Term: description run', () => {
    const f = extractFeatures(
      'Water: zero-aura npc energy.\nHot Coffee: corporate hustle-grindset core.\n' +
        'Iced Tea: coastal-grandmother delusional.\nRed Bull: unhinged goblincore panic.',
    )
    expect(f.labelledListicle).toBeGreaterThan(0.5)
  })

  it('needs three lines — two is a coincidence, three is a format', () => {
    expect(
      extractFeatures('Water: something here.\nCoffee: something else here.').labelledListicle,
    ).toBe(0)
  })

  it('does not fire on ordinary prose containing a colon', () => {
    const f = extractFeatures(
      'We shipped it on Tuesday: the migration took three weeks and went fine. ' +
        'The hard part was the data, not the code. Thanks to everyone who helped out.',
    )
    expect(f.labelledListicle).toBe(0)
  })

  it('counts bullet glyphs, not just emoji', () => {
    const f = extractFeatures('Key points:\n• First thing\n• Second thing\n• Third thing')
    expect(f.bulletRate).toBeGreaterThan(0.5)
    expect(f.emojiBulletRate).toBe(0)
  })
})

describe('questionCloser is structural, not a phrase list', () => {
  it('fires on any question as the final line', () => {
    // "What's your favorite HTTP code?" was the closer on a real missed post and matched none of
    // the original hardcoded phrases.
    expect(extractFeatures('Some list of things.\n\nWhat is your favourite status code?').questionCloser).toBe(1)
    expect(extractFeatures('Some thoughts on hiring.\n\nAgree?').questionCloser).toBe(1)
  })

  it('does not fire on a question in the middle', () => {
    expect(
      extractFeatures('Why does this happen? Because of how retries work. We fixed it on Tuesday.')
        .questionCloser,
    ).toBe(0)
  })
})

describe('concreteness does not treat digit soup as substance', () => {
  it('scores a number-dense explainer below a genuinely specific post', () => {
    // An HTTP status-code post scored concreteness 1.00 purely on digits, which zeroed its
    // abstractness and discounted its whole score — so a formulaic explainer read as maximally
    // specific and routed `clean`.
    const digitSoup = extractFeatures(
      '200 means success. 301 means moved. 400 means bad request. 403 means forbidden. ' +
        '404 means not found. 429 means too many. 500 means error. 503 means unavailable.',
    )
    const reallySpecific = extractFeatures(
      'Priya and Tom spent Tuesday migrating the Stripe reconciliation job off the legacy ' +
        'currency column in our Manchester Postgres cluster.',
    )
    expect(reallySpecific.concreteness).toBeGreaterThan(digitSoup.concreteness)
  })
})

describe('emoji-prefixed labels (a real missed job-spam post)', () => {
  it('detects a label listicle whose lines start with emoji', () => {
    // The commonest form of this shape on LinkedIn, and it scored 0.00 because the regex
    // required lines to start with a letter.
    const f = extractFeatures(
      '💻 Role: Software Engineer\n🏢 Company: Apple\n📍 Location: Bengaluru, India',
    )
    expect(f.labelledListicle).toBeGreaterThan(0.5)
  })

  it('detects short values like "Company: Apple"', () => {
    // The second half of the same bug: values had to be 8+ characters.
    const f = extractFeatures('Role: Engineer\nCompany: Apple\nLocation: Pune')
    expect(f.labelledListicle).toBeGreaterThan(0.5)
  })

  it('detects bullet-prefixed labels too', () => {
    const f = extractFeatures('• Role: Engineer\n• Company: Apple\n• Location: Pune')
    expect(f.labelledListicle).toBeGreaterThan(0.5)
  })

  it('still does not fire on ordinary prose with a colon', () => {
    expect(
      extractFeatures(
        'We shipped it on Tuesday: the migration took three weeks and went fine overall. ' +
          'The hard part was the data rather than the code, as it usually is.',
      ).labelledListicle,
    ).toBe(0)
  })
})

describe('followBait', () => {
  it.each([
    '👉 Follow Sahil Hans for more job updates, hiring alerts & career opportunities.',
    'Follow me for more content like this.',
    'Connect with Jane Doe for daily insights.',
    'Follow us to get weekly updates.',
  ])('detects %s', (text) => {
    expect(extractFeatures(text).followBait).toBe(1)
  })

  it.each([
    'I follow a lot of people who post about distributed systems.',
    'You should follow the migration guide before upgrading.',
    'We had to follow up with the vendor twice.',
  ])('does not fire on %s', (text) => {
    expect(extractFeatures(text).followBait).toBe(0)
  })
})
