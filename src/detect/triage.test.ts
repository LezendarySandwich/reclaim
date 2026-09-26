import { describe, expect, it } from 'vitest'
import { MIN_WORDS, PROVISIONAL_SLOP_ABOVE, RULES_VERSION, needsModel, route } from './triage'

/**
 * Corpus note: these are hand-written samples, not a measured dataset. They pin BEHAVIOUR we have
 * committed to (fairness, no silent misses), not accuracy. Real calibration comes from shadow
 * mode — see docs/features/003-triage-router/plan.md.
 */

const CLEAN_HUMAN = [
  `Spent Saturday debugging a race in our payment reconciliation job. Turned out the retry
  used the same idempotency key as the original call, so Stripe happily returned the cached
  200 and we marked 41 failed charges as settled. Took four hours and an embarrassing amount
  of coffee. Fix was three lines. Postmortem doc is in the usual place if anyone wants it.`,

  `We're hiring two backend engineers in Manchester. Go stack, Postgres, a fair amount of
  legacy PHP you'd help us delete. Salary band is 65-85k, published, no negotiation games.
  Hybrid, two days in. If that sounds decent, my DMs are open and I'll answer even if it's
  a no.`,
]

/**
 * Non-native English speakers are the dominant false-positive population. Liang et al. measured
 * 61.22% FPR across seven commercial detectors on TOEFL essays; a 2026 mechanistic paper shows
 * detectors rate the median formal-native human essay as 99.5% likely AI.
 *
 * ADR-004 exists because of this. These samples are formal, slightly non-idiomatic, human.
 */
const NON_NATIVE_HUMAN = [
  `I am very happy to share that I have completed my master degree in Computer Science from
  Technical University. It was not easy journey for me. I want to thank my supervisor who
  guide me during all this time, and my family who support me always. Now I am looking for
  opportunity in data engineering field. If you know any position, please kindly inform me.`,

  `Yesterday I have attended the conference about renewable energy in Berlin. There were many
  interesting presentations, specially the one regarding grid storage. I have learned that the
  main problem is not the generation but the distribution. I think this is important topic for
  our industry and we should discuss more about it in the future.`,

  `In my previous company I was responsible for managing the team of five developers. We have
  delivered the project on time despite of many challenges. I believe that good communication
  is the key for success in any team. Currently I am open for new challenges and opportunities
  where I can apply my experience.`,
]

/** Unornamented LLM prose: no em-dashes, no emoji, no obvious tells. The hard case. */
const PLAIN_LLM = [
  `Effective leadership is not about having all the answers. It is about creating an environment
  where the right questions can be asked. The best leaders I have worked with share three
  qualities: they listen more than they speak, they give credit generously, and they take
  responsibility when things go wrong. Building this kind of culture takes time and consistency.
  It requires showing up every day with the same values, even when it is difficult.`,

  `Remote work has fundamentally changed how teams collaborate. Organisations that adapt quickly
  will have a significant advantage in attracting talent. The key is not simply replicating
  office processes online. It is rethinking what collaboration actually means. Teams that
  succeed focus on outcomes rather than hours, on clarity rather than presence, and on trust
  rather than supervision.`,
]

const ENGAGEMENT_BAIT = [
  `I was rejected from 47 jobs.\n\nToday I run a 7-figure agency.\n\nHere's what I learned:\n\n
  Most people give up too early.\n\nSuccess is just failure that kept going.\n\nAgree?`,

  `🚀 STOP scrolling.\n\n💡 I built a 30-page playbook on personal branding.\n\n🔥 It took me
  6 months.\n\n✅ I'm giving it away free.\n\nComment "GROWTH" below and I'll send it to you.`,
]

describe('fairness — the commitment ADR-004 exists to protect', () => {
  it.each(NON_NATIVE_HUMAN.map((t, i) => [i, t] as const))(
    'non-native English sample %i is never routed likely_slop',
    (_i, text) => {
      const r = route(text)
      expect(r.band).not.toBe('likely_slop')
    },
  )

  it('keeps the ai sub-score low on non-native writing', () => {
    // Not an accuracy claim — a guard. If a future weighting change pushes these up, this fails
    // loudly rather than silently penalising a whole population of writers.
    for (const text of NON_NATIVE_HUMAN) {
      expect(route(text).ai).toBeLessThan(0.55)
    }
  })
})

describe('no silent misses', () => {
  it.each(PLAIN_LLM.map((t, i) => [i, t] as const))(
    'plain unornamented LLM prose %i reaches at least ambiguous',
    (_i, text) => {
      // `clean` is the only expensive mistake: the model never sees the post.
      expect(route(text).band).not.toBe('clean')
      expect(needsModel(route(text).band)).toBe(true)
    },
  )

  it.each(ENGAGEMENT_BAIT.map((t, i) => [i, t] as const))(
    'engagement bait %i reaches the model',
    (_i, text) => {
      expect(needsModel(route(text).band)).toBe(true)
    },
  )

  it('scores the comment-gate pattern highly — it is near-unambiguous', () => {
    const r = route(ENGAGEMENT_BAIT[1]!)
    expect(r.bait).toBeGreaterThan(0.4)
  })
})

describe('clean writing is allowed through without inference', () => {
  it.each(CLEAN_HUMAN.map((t, i) => [i, t] as const))(
    'specific, concrete human writing %i routes clean',
    (_i, text) => {
      expect(route(text).band).toBe('clean')
    },
  )
})

describe('the router routes, it does not judge (ADR-004)', () => {
  it('returns only a band, never an action or a verdict', () => {
    const r = route(ENGAGEMENT_BAIT[0]!)
    expect(['clean', 'ambiguous', 'likely_slop']).toContain(r.band)
    expect(r).not.toHaveProperty('action')
    expect(r).not.toHaveProperty('verdict')
  })

  it('needsModel is false only for clean', () => {
    expect(needsModel('clean')).toBe(false)
    expect(needsModel('ambiguous')).toBe(true)
    expect(needsModel('likely_slop')).toBe(true)
  })
})

describe('short text', () => {
  it('routes below MIN_WORDS to ambiguous rather than inventing a signal', () => {
    const r = route('Thrilled to announce I have joined a new company today. Very excited.')
    expect(r.features.wordCount).toBeLessThan(MIN_WORDS)
    expect(r.band).toBe('ambiguous')
    expect(r.shortCircuited).toBe(true)
  })

  it('does not score short text at all', () => {
    const r = route('Not just a job. A calling.')
    expect(r.score).toBe(0)
  })
})

describe('edge cases', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '   \n\n\t  '],
    ['one word', 'Hello'],
    ['only punctuation', '!!!???...'],
    ['only emoji', '🚀🚀🚀'],
    ['no spaces', 'a'.repeat(3000)],
    ['5000 words', 'word '.repeat(5000)],
    ['CJK', '很高兴宣布我加入了新公司。'.repeat(20)],
    ['RTL', 'يسعدني أن أعلن انضمامي إلى شركة جديدة. '.repeat(20)],
  ])('does not throw on %s', (_label, text) => {
    expect(() => route(text)).not.toThrow()
  })

  it('treats empty text as clean-and-short-circuited, not as a signal', () => {
    const r = route('')
    expect(r.shortCircuited).toBe(true)
    expect(r.score).toBe(0)
  })
})

describe('performance', () => {
  it('stays well under budget for a 400-word post', () => {
    const text = CLEAN_HUMAN[0]!.repeat(6)
    const iterations = 500
    const start = performance.now()
    for (let i = 0; i < iterations; i++) route(text)
    const perCall = (performance.now() - start) / iterations
    // Target is <1ms. Asserting 5ms — this is a smoke alarm for catastrophic backtracking, not a
    // benchmark, and CI machines are slow.
    expect(perCall).toBeLessThan(5)
  })

  it('does not blow up on adversarial repetition', () => {
    const start = performance.now()
    route('not just a, but b. '.repeat(500))
    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe('RULES_VERSION', () => {
  it('is exported and marked uncalibrated', () => {
    expect(RULES_VERSION).toContain('uncalibrated')
  })
})

describe('likely_slop must be reachable (regression)', () => {
  // This band was DEAD for a whole release. The scoring function divided by the sum of all
  // weights, so a post firing only `commentGate` — the strongest single marker at 0.85 — scored
  // 0.85/2.95 ≈ 0.29, and nothing on a real feed ever crossed 0.55. The agreement panel showed
  // zero in both of its likely_slop rows, which is how it was noticed. Nothing in the test suite
  // caught it, because no test asserted the band was reachable at all.

  // All at least MIN_WORDS long. Two earlier fixtures here were 21 and 23 words and therefore
  // short-circuited to `ambiguous` with score 0 — they were testing the length guard, not the
  // scoring, and failed for a reason that had nothing to do with what they claimed to check.
  const CLEAR_BAIT = [
    'Comment "GUIDE" below and I will send you the playbook. It took me six months to write and I am giving it away free today only, so do not miss out.',
    'I was rejected from 47 different jobs over eighteen months.\n\nToday I run a seven figure agency with a team of twelve people.\n\nHere\'s what I learned along the way:\n\nMost people give up far too early.\n\nSuccess is just failure that kept on going.\n\nAgree?',
    '🚀 5 lessons from scaling to ten thousand users\n\n💡 Listen to your customers every single day\n\n✅ Ship fast and iterate constantly\n\n🔥 Hire slowly and fire quickly\n\n📈 Measure everything that actually matters\n\nWhich of these resonates most with you?',
  ]

  it.each(CLEAR_BAIT.map((t, i) => [i, t] as const))(
    'unambiguous bait %i reaches likely_slop',
    (_i, text) => {
      expect(route(text).band).toBe('likely_slop')
    },
  )

  it('a single decisive marker is enough — signals are independent evidence', () => {
    // The modelling point: a comment-gated lead magnet is bait whether or not it also has emoji
    // bullets. Averaging across markers made one strong signal look weak.
    const onlyCommentGate =
      'Comment "GUIDE" below and I will send you the playbook. ' +
      'It is a straightforward document about a normal professional subject with no other markers at all.'
    expect(route(onlyCommentGate).bait).toBeGreaterThan(PROVISIONAL_SLOP_ABOVE)
  })

  it('and the fairness guarantee still holds under the new combination', () => {
    // The risk of making signals combine more readily is that innocuous writing starts firing.
    const nonNative =
      'In my previous company I was responsible for managing the team of five developers. ' +
      'We have delivered the project on time despite of many challenges. I believe that good ' +
      'communication is the key for success in any team. Currently I am open for new challenges.'
    expect(route(nonNative).band).not.toBe('likely_slop')
  })
})
