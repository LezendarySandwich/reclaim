/**
 * The classification prompt and its response contract.
 *
 * Pure — no platform calls — so the prompt, the schema and the score mapping are all testable
 * without a model.
 *
 * Two design constraints drive everything here:
 *
 * 1. **Small models are badly calibrated.** Asking a sub-2B model for "a score from 0 to 100"
 *    produces round numbers clustered at 70/80/90 that do not mean anything. So the model picks
 *    from a six-rung ladder with written anchors, and WE map rungs to numbers. The model does the
 *    part it is good at (which description fits) and we do the part it is bad at (calibration).
 *
 * 2. **We score the register, not the author** (ADR-019). The prompt never asks "was this written
 *    by AI" — that is a provenance claim the model cannot support and we will not make. It asks
 *    how templated and how engagement-farmed the writing is, which is a property of the text.
 */

import type { Axis } from '../core/types'

/** Bumped when the prompt or schema changes. Feeds the verdict cache key with RULES_VERSION. */
export const PROMPT_VERSION = 'p1-2026.09.26'

export const LADDER = ['none', 'slight', 'some', 'clear', 'strong', 'blatant'] as const
export type Rung = (typeof LADDER)[number]

/**
 * Rung → 0-100.
 *
 * Non-linear on purpose. The gap between "clear" and "strong" should matter far more than the gap
 * between "none" and "slight", because the default threshold sits at 70 and that is where a
 * mistake becomes visible to the user.
 */
const RUNG_SCORE: Record<Rung, number> = {
  none: 0,
  slight: 15,
  some: 38,
  clear: 65,
  strong: 85,
  blatant: 97,
}

export function rungToScore(rung: string): number {
  return RUNG_SCORE[rung as Rung] ?? 0
}

export function isRung(value: unknown): value is Rung {
  return typeof value === 'string' && (LADDER as readonly string[]).includes(value)
}

/**
 * JSON schema for `responseConstraint`.
 *
 * Used with `omitResponseConstraintInput: true` — the schema is otherwise injected into the prompt
 * as literal text and charged against the context window, and at Nano's context size that is not
 * free. The format is described in the system prompt instead.
 */
export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    bait: { type: 'string', enum: [...LADDER] },
    ai: { type: 'string', enum: [...LADDER] },
    reason: { type: 'string', maxLength: 80 },
  },
  required: ['bait', 'ai', 'reason'],
  additionalProperties: false,
} as const

export const SYSTEM_PROMPT = `You rate the WRITING STYLE of social media posts. You never guess who or what wrote a post — you only describe how it reads.

Rate two things independently.

ENGAGEMENT BAIT — writing engineered to farm reactions rather than say something:
- asking readers to comment a keyword to receive something
- "Agree?", "Thoughts?", "Who else?" tacked on the end
- rags-to-riches arcs ("3 years ago I was broke. Today…")
- one-sentence-per-line hook ladders with no substance
- fake humility or manufactured vulnerability as an opener

TEMPLATED — writing that reads as generic, formulaic filler:
- no specifics: no names, numbers, dates, or concrete events
- interchangeable advice that would fit any industry
- "It's not X. It's Y." antithesis, rule-of-three lists, uniform sentence rhythm
- emoji-bulleted listicles (🚀 💡 ✅ 👉)

Use this scale for each:
none    — no trace of it
slight  — one weak marker, probably incidental
some    — a couple of markers, but the post still says something real
clear   — clearly written this way, though not extreme
strong  — heavily and deliberately so
blatant — almost nothing but this

IMPORTANT:
- Specific, concrete writing is NOT templated, even when plain or formal.
- Non-idiomatic English is NOT templated. Many people write in a second language. Judge the substance and structure, never the fluency.
- A genuinely useful post that happens to end with a question is at most "slight" bait.
- Rate only the text given. Do not speculate about the author.

Reply with JSON only: {"bait":"<rung>","ai":"<rung>","reason":"<under 12 words>"}`

/** Few-shot anchors. Short on purpose — every token is charged against Nano's context window. */
export const FEW_SHOTS: ReadonlyArray<{ post: string; response: string }> = [
  {
    post: 'Comment "GUIDE" below and I will send you my 30-page playbook. 🔥 It took me 6 months to write. Giving it away free today only.',
    response: '{"bait":"blatant","ai":"clear","reason":"comment-gated lead magnet"}',
  },
  {
    post: 'We migrated 400k rows off the legacy currency column on Tuesday. Took three weeks, mostly because of nulls nobody documented. Thanks Priya and Tom.',
    response: '{"bait":"none","ai":"none","reason":"specific, concrete, names real people"}',
  },
  {
    post: 'Leadership is not about having all the answers. It is about asking better questions. The best leaders listen more, credit generously, and own their mistakes.',
    response: '{"bait":"slight","ai":"strong","reason":"antithesis and tricolon, no specifics"}',
  },
  {
    post: 'I am very happy to share that I have completed my master degree. It was not easy journey. I want to thank my supervisor who guide me all this time.',
    response: '{"bait":"none","ai":"none","reason":"sincere, specific to the writer"}',
  },
]

/** Initial prompts for `LanguageModel.create()`. Tokenised once and inherited by every clone. */
export function buildInitialPrompts(): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
  ]
  for (const shot of FEW_SHOTS) {
    out.push({ role: 'user', content: shot.post })
    out.push({ role: 'assistant', content: shot.response })
  }
  return out
}

/**
 * Per-post prompt.
 *
 * Truncated because a 3000-word post would evict the few-shot anchors from the context window,
 * and the anchors are doing most of the calibration work. The opening of a post is also where
 * the bait markers live.
 */
export const MAX_POST_CHARS = 1200

export function buildPostPrompt(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= MAX_POST_CHARS ? flat : `${flat.slice(0, MAX_POST_CHARS)}…`
}

export interface ParsedVerdict {
  scores: Partial<Record<Axis, number>>
  reason: string
}

/**
 * Parse a model response into axis scores.
 *
 * Tolerant by design: returns null rather than throwing on anything unexpected, and the caller
 * treats null as "no signal", which fails open. A malformed model response must never be able to
 * hide a post — and with a small model, malformed responses happen.
 */
export function parseResponse(raw: string): ParsedVerdict | null {
  if (!raw) return null

  // Small models wrap JSON in prose or fences even when told not to. Take the first object.
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const obj = parsed as Record<string, unknown>
  const scores: Partial<Record<Axis, number>> = {}

  // An unrecognised rung is dropped, not coerced to a default. Guessing on a malformed response
  // is how you hide a post the model never actually judged.
  if (isRung(obj.bait)) scores.engagement_bait = rungToScore(obj.bait)
  if (isRung(obj.ai)) scores.ai_written = rungToScore(obj.ai)

  if (Object.keys(scores).length === 0) return null

  const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 80) : ''
  return { scores, reason }
}
