/**
 * Pure feature extraction from post text.
 *
 * Every feature is normalised to 0-1 and documented with what a HIGH value means. Nothing here
 * decides anything — these feed the triage router, which routes and does not judge (ADR-004).
 *
 * No platform dependencies. Testable in plain node.
 */

/** Scale a raw rate into 0-1, saturating at `atOne`. */
function ramp(value: number, atOne: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(1, value / atOne)
}

export interface Features {
  wordCount: number

  // --- typography -------------------------------------------------------------------------
  /** High: unusually em-dash heavy. Population-level signal only — see note below. */
  emDashRate: number
  /** High: curly quotes/apostrophes, which most humans do not type by hand. */
  curlyPunctRate: number
  /** High: lines that open with an emoji bullet. The "🚀 Point one" listicle shape. */
  emojiBulletRate: number
  /** High: emoji-dense throughout, not just at line starts. */
  emojiDensity: number
  /**
   * High: uses the specific small set of emoji that LLM-written LinkedIn posts reach for
   * constantly — 🚀 💡 ✅ 👉 🔥 and friends. Much narrower and higher-precision than raw density:
   * plenty of people use emoji, far fewer bullet a listicle with 👉.
   */
  slopEmojiRate: number
  /** High: ALL-CAPS opener words used as a hook. */
  allCapsHookRate: number

  // --- rhythm -----------------------------------------------------------------------------
  /** High: sentence lengths are unusually UNIFORM. Human writing is burstier. */
  sentenceUniformity: number
  /** High: paragraph lengths are unusually uniform. */
  paragraphUniformity: number
  /** High: mostly one-line paragraphs. LinkedIn "broetry". */
  oneLineParaRatio: number

  // --- construction -----------------------------------------------------------------------
  /** High: "not just X, but Y" / "It's not X. It's Y." antithesis. */
  antithesisRate: number
  /** High: rule-of-three lists. */
  tricolonRate: number
  /** High: hedging words per 100 words. */
  hedgingRate: number
  /** High: text is CONCRETE — digits, proper nouns, specifics. Counter-signal to slop. */
  concreteness: number
  /**
   * High: text is generic — no numbers, no names, no specifics. Simply `1 - concreteness`, kept
   * as its own field so the router can weight it directly rather than casting.
   *
   * Measured on the sample corpus this is the single strongest separator: generic LLM prose
   * scores 1.00 against 0.15-0.23 for specific human writing. It does NOT separate LLM prose from
   * non-native writing, exactly as the literature predicts — acceptable for a router, and the
   * reason nothing like it may ever appear in something that hides.
   */
  abstractness: number

  // --- engagement bait --------------------------------------------------------------------
  /** High: closes by soliciting a reply ("Agree?", "Thoughts?"). */
  questionCloser: number
  /** High: asks for a comment to unlock something. Near-unambiguous bait. */
  commentGate: number
  /** High: "X years ago I was… Today I…" reversal-of-fortune framing. */
  timeContrast: number
  /** High: "Here's what I learned:", "I'll go first", fake-humility openers. */
  humbleOpener: number
}

export const EMPTY_FEATURES: Features = {
  wordCount: 0,
  emDashRate: 0,
  curlyPunctRate: 0,
  emojiBulletRate: 0,
  emojiDensity: 0,
  slopEmojiRate: 0,
  allCapsHookRate: 0,
  sentenceUniformity: 0,
  paragraphUniformity: 0,
  oneLineParaRatio: 0,
  antithesisRate: 0,
  tricolonRate: 0,
  hedgingRate: 0,
  concreteness: 0,
  abstractness: 0,
  questionCloser: 0,
  commentGate: 0,
  timeContrast: 0,
  humbleOpener: 0,
}

const HEDGES =
  /\b(?:arguably|perhaps|somewhat|relatively|fairly|quite|rather|generally|typically|often|essentially|fundamentally|ultimately|truly|simply|merely|virtually|largely|broadly)\b/giu

const EMOJI_CLASS =
  String.raw`[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{1F900}-\u{1F9FF}]`
const EMOJI = new RegExp(EMOJI_CLASS, 'u')
const EMOJI_GLOBAL = new RegExp(`${EMOJI_CLASS}\u{FE0F}?`, 'gu')

/**
 * A line that OPENS with an emoji, allowing leading whitespace and a variation selector.
 *
 * The earlier version tested `line.slice(0, 3)`, which could slice a surrogate pair in half and
 * missed any line with leading indentation.
 */
const EMOJI_BULLET_LINE = new RegExp(String.raw`^\s*${EMOJI_CLASS}`, 'u')

/**
 * The emoji LLM-written LinkedIn posts reach for, over and over.
 *
 * Deliberately a small hand-picked set rather than "emoji in general". Emoji use is cultural and
 * generational — penalising it broadly would be another proxy for a demographic, which is exactly
 * the mistake ADR-004 exists to avoid. What is distinctive is not *that* a post uses emoji but
 * *which*: the 🚀/💡/✅/👉 rocket-lightbulb-tick-pointer vocabulary of a generated listicle. 👉 and
 * 👇 as bullet glyphs are the strongest tells in the set.
 */
const SLOP_EMOJI = new Set([
  '🚀', '💡', '✅', '👉', '👇', '🔥', '✨', '🎯', '💪', '🙌',
  '🤝', '📈', '💯', '⚡', '🌟', '🧠', '📊', '🔑', '⭐', '➡',
  '✔', '🎉', '💰', '🏆', '📌', '🔗', '💥', '🙏', '👏', '🌱',
])

/**
 * Antithesis: "not just X but Y", "It's not X. It's Y.", "X is not about Y. It is about Z.",
 * "Success is not luck, it is preparation."
 *
 * Assembled from a shared IT_IS part rather than hand-written, because the contracted and
 * uncontracted forms both occur and writing them out by hand kept missing one. Two earlier
 * versions failed on "It's not a job. It's a calling." (the right-hand side demanded
 * `it` + whitespace + `'s`, and a contraction has no space) and on "Success is not luck, it is
 * preparation." (clause separator is a comma, and the verb is uncontracted).
 */
const IT_IS = String.raw`(?:it|that|this)(?:(?:'|’)s|\s+(?:is|was))`
const ANTITHESIS = new RegExp(
  [
    // not just/only/merely/simply X, but Y
    String.raw`\bnot\s+(?:just|only|merely|simply)\b[^.!?\n]{2,80}?\bbut\b`,
    // <subject> is not [about] X <. ! ? ,> It is [about] Y — either clause separator
    String.raw`(?:\b(?:is|are|was|were)\s+not\b|\b` + IT_IS + String.raw`\s+not\b)` +
      String.raw`(?:\s+about)?[^.!?\n]{2,80}[.!?,]\s*` + IT_IS + String.raw`\s`,
  ].join('|'),
  'giu',
)

// Rule of three, closing with and/or: "faster, cheaper, and better", but also the far commoner
// phrasal form "they listen more than they speak, they give credit generously, and they take
// responsibility". The first version required single-word items and therefore missed every
// realistic instance.
const TRICOLON = /[^,.!?\n]{3,60},\s*[^,.!?\n]{3,60},\s*(?:and|or)\s+[^,.!?\n]{3,60}/giu

// Comment-gated lead magnet: "comment GUIDE below and I'll send it". Near-unambiguous bait — the
// post states its own mechanism. Both contracted and uncontracted forms occur ("I'll send" and
// "I will send"); an earlier version required the contraction and missed half of them.
const COMMENT_GATE =
  /\b(?:comment|drop|type)\s+(?:["'“”]?[A-Z]{2,}["'“”]?|below|the\s+word)\b[^.!?\n]{0,60}?(?:\b(?:i|we)\s+(?:will|can)\s+(?:send|dm|share|give)\b|\b(?:i|we)(?:'|’)ll\s+(?:send|dm|share|give)\b|\bto\s+(?:get|receive|unlock|download)\b)/giu

const QUESTION_CLOSER =
  /(?:^|\n)\s*(?:agree\?|thoughts\?|am\s+i\s+wrong\?|what\s+do\s+you\s+think\?|who\s+else\?|right\?)\s*$/iu

const TIME_CONTRAST =
  /\b\d{1,2}\s+(?:years?|months?|weeks?|days?)\s+ago\b[^]{0,200}?\b(?:today|now|fast\s+forward)\b/iu

const HUMBLE_OPENER =
  /(?:^|\n)\s*(?:here(?:'|’)?s\s+what\s+i\s+(?:learned|discovered)|i(?:'|’)?ll\s+go\s+first|(?:i\s+)?(?:am|'m|’m)\s+(?:humbled|thrilled|honou?red|excited)\s+to|unpopular\s+opinion|let\s+that\s+sink\s+in)/iu

const PROPER_NOUN = /(?<![.!?]\s)(?<!^)\b[A-Z][a-z]{2,}\b/gmu

function count(text: string, re: RegExp): number {
  // Fresh lastIndex each call — these are module-level /g regexes and are reused.
  re.lastIndex = 0
  let n = 0
  while (re.exec(text) !== null) {
    n++
    if (n > 500) break // pathological input guard
  }
  return n
}

/** Coefficient of variation, inverted so HIGH means UNIFORM. */
function uniformity(lengths: number[]): number {
  if (lengths.length < 3) return 0
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length
  if (mean === 0) return 0
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length
  const cv = Math.sqrt(variance) / mean
  // Human prose typically sits around cv 0.6-0.9. Below ~0.35 is suspiciously even.
  return Math.max(0, Math.min(1, 1 - cv / 0.6))
}

export function extractFeatures(text: string): Features {
  if (!text || !text.trim()) return { ...EMPTY_FEATURES }

  const words = text.trim().split(/\s+/u)
  const wordCount = words.length
  const per100 = (n: number) => (n / wordCount) * 100

  const lines = text.split('\n').map((l) => l.trim())
  const nonEmptyLines = lines.filter((l) => l.length > 0)
  const paragraphs = text
    .split(/\n\s*\n/u)
    .map((p) => p.trim())
    .filter(Boolean)
  const sentences = text
    .split(/(?<=[.!?])[\s\n]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)

  const emDashes = (text.match(/—/gu) ?? []).length
  const curly = (text.match(/[“”‘’]/gu) ?? []).length

  const emojiBulletLines = nonEmptyLines.filter((l) => EMOJI_BULLET_LINE.test(l)).length

  EMOJI_GLOBAL.lastIndex = 0
  const allEmoji = text.match(EMOJI_GLOBAL) ?? []
  // Strip variation selectors before set lookup: "➡️" is U+27A1 U+FE0F, and the set holds bare
  // code points so both the plain and the emoji-presentation form match.
  const slopEmoji = allEmoji.filter((e) => SLOP_EMOJI.has(e.replace(/\uFE0F/gu, '')))
  const allCapsHooks = nonEmptyLines.filter((l) =>
    /^[A-Z][A-Z\s!:.]{3,}[:!]/u.test(l.slice(0, 40)),
  ).length

  const digits = (text.match(/\d/gu) ?? []).length
  const properNouns = count(text, PROPER_NOUN)
  const concreteness = Math.min(
    1,
    ramp(per100(digits), 4) * 0.5 + ramp(per100(properNouns), 6) * 0.5,
  )

  return {
    wordCount,

    emDashRate: ramp(per100(emDashes), 2),
    curlyPunctRate: ramp(per100(curly), 4),
    emojiBulletRate: nonEmptyLines.length ? emojiBulletLines / nonEmptyLines.length : 0,
    emojiDensity: ramp(per100(allEmoji.length), 8),
    slopEmojiRate: ramp(per100(slopEmoji.length), 4),
    allCapsHookRate: nonEmptyLines.length ? allCapsHooks / nonEmptyLines.length : 0,

    sentenceUniformity: uniformity(sentences.map((s) => s.split(/\s+/u).length)),
    paragraphUniformity: uniformity(paragraphs.map((p) => p.split(/\s+/u).length)),
    oneLineParaRatio:
      paragraphs.length >= 3
        ? paragraphs.filter((p) => !p.includes('\n') && p.split(/\s+/u).length <= 14).length /
          paragraphs.length
        : 0,

    antithesisRate: ramp(count(text, ANTITHESIS), 2),
    tricolonRate: ramp(count(text, TRICOLON), 2),
    hedgingRate: ramp(per100(count(text, HEDGES)), 4),
    concreteness,
    abstractness: 1 - concreteness,

    questionCloser: QUESTION_CLOSER.test(text.trim()) ? 1 : 0,
    commentGate: count(text, COMMENT_GATE) > 0 ? 1 : 0,
    timeContrast: TIME_CONTRAST.test(text) ? 1 : 0,
    humbleOpener: HUMBLE_OPENER.test(text) ? 1 : 0,
  }
}
