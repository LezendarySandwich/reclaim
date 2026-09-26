/**
 * Core domain types. Zero platform dependencies — no `chrome.*`, no DOM.
 * Everything here must be unit-testable in plain node.
 */

/** The independent things we score a post on. Adding one must not require pipeline changes. */
export type Axis = 'ai_written' | 'engagement_bait' | 'ai_image' | 'sponsored'

export const ALL_AXES: readonly Axis[] = ['ai_written', 'engagement_bait', 'ai_image', 'sponsored']

/** Where a signal came from. Determines how much weight it can carry — see ADR-004. */
export type SignalSource =
  /** Cheap in-tab scoring. Routes posts to the model; may never produce a hide on its own. */
  | 'heuristic'
  /** An on-device model verdict. */
  | 'model'
  /** Structural fact read off the page or the media — a platform label, a C2PA manifest. */
  | 'metadata'

export interface ContentSignal {
  /** 0-100. Higher means more confident the axis applies. */
  score: number
  source: SignalSource
  /** Short human-readable justification, shown in the dashboard. */
  reason?: string
}

/** A post as extracted from a feed, before any scoring. Site-agnostic. */
export interface Post {
  /** Stable within a session; ideally stable across sessions. See adapter docs for provenance. */
  id: string
  /** Stable creator identity — the key the leaderboard aggregates on. */
  authorUrn: string
  authorName: string
  /** Full body text, untruncated. Adapters must expand "see more" without clicking. */
  text: string
  media: MediaRef[]
  isPromoted: boolean
  isRepost: boolean
  /** Which adapter produced this. */
  site: string
}

export interface MediaRef {
  kind: 'image' | 'video'
  url: string
}

/** The triage router's only output. It routes; it does not decide. */
export type TriageBand = 'clean' | 'ambiguous' | 'likely_slop'

export type VerdictAction = 'show' | 'collapse'

export interface Verdict {
  postId: string
  signals: Partial<Record<Axis, ContentSignal>>
  action: VerdictAction
  /** Which axes crossed their threshold. Empty when action is 'show'. */
  triggeredBy: Axis[]
  /** Identifies the model that produced this. Part of the cache key. */
  engineId: string
  /** Heuristic + prompt version. Part of the cache key, so shipping new rules invalidates cleanly. */
  rulesVersion: string
}

/**
 * Cache identity for a verdict. Changing rules or engine invalidates every stale verdict with no
 * manual bust — see ADR-010.
 */
export interface VerdictKey {
  postId: string
  textHash: string
  rulesVersion: string
  engineId: string
}

/** User feedback on a verdict. The accuracy denominator and future training data. */
export interface Label {
  postId: string
  axis: Axis
  /** true = the user agrees the axis applies. */
  userSays: boolean
  /** The score at the time they disagreed, so we can measure calibration drift. */
  verdictAtTime: number
  at: number
}

/**
 * Model lifecycle. Fail-open is a state machine, not a boolean (ADR-005): only `ready` may
 * produce a `collapse`.
 */
export type EngineState =
  | { status: 'uninitialized' }
  | { status: 'checking' }
  /** No model chosen yet. First run sits here until the user picks one. */
  | { status: 'needs_setup' }
  | { status: 'downloading'; fraction: number }
  | { status: 'ready'; engineId: string }
  /**
   * Cannot run, and will not without user or admin action. `reason` distinguishes causes the user
   * can fix from ones they cannot — note that hardware-gating and enterprise policy are
   * indistinguishable from an extension, so the copy must cover both (brief R15).
   */
  | { status: 'degraded'; reason: DegradedReason; detail?: string }

export type DegradedReason =
  | 'no_webgpu'
  | 'unsupported_hardware_or_policy'
  | 'download_failed'
  | 'engine_error'

/** Only this state may hide anything. Everything else fails open. */
export function canHide(state: EngineState): state is { status: 'ready'; engineId: string } {
  return state.status === 'ready'
}

/**
 * What an axis is allowed to do (ADR-019).
 *
 * A boolean cannot express this: `ai_written` must be scored and recorded, so the dashboard can
 * report accuracy and we can calibrate, while never hiding anything. The literature does not
 * support hiding on it — at post length, published detectors score near chance, and Liang et al.
 * measured a 61.22% false-positive rate on non-native English writers.
 */
export type AxisMode =
  /** Not scored at all. */
  | 'off'
  /** Scored and recorded, never collapses. How we measure before trusting. */
  | 'shadow'
  /** Scored, recorded, and may collapse. */
  | 'enabled'

export interface AxisSetting {
  mode: AxisMode
  /** 0-100. A post collapses when an `enabled` axis scores at or above this. */
  threshold: number
}

export interface Settings {
  axes: Record<Axis, AxisSetting>
  /** Creators never collapsed, whatever they post. Their posts are still scored — see 002 plan. */
  allowlist: string[]
  /** Days of post history to retain. */
  retentionDays: number
  /** Global kill switch for hiding. Forces every axis to behave as `shadow`. */
  shadowMode: boolean
}

/**
 * v1 defaults.
 *
 * `ai_written` is enabled but at a deliberately extreme threshold (ADR-025). The model answers on
 * a six-rung ladder mapped to none=0, slight=15, some=38, clear=65, strong=85, blatant=97 — so a
 * threshold of 90 means **only `blatant` hides**. "Strong" is not enough.
 *
 * That is the narrowest possible reading of "high confidence", and it is narrow on purpose: at
 * post length, published detectors score near chance, and the measured false positives fall
 * hardest on people writing in a second language. One rung is the whole safety margin.
 *
 * `engagement_bait` sits much lower at 70 because it is a different kind of judgement — the text
 * states its own intent, a user can verify a flag instantly, and being wrong is embarrassing
 * rather than defamatory.
 *
 * `sponsored` is enabled and works with no model at all (ADR-026): LinkedIn labels its own ads
 * "Promoted", so there is nothing to infer. Note this is the one axis LinkedIn's User Agreement
 * names explicitly — §8.2 prohibits "removing, covering, or obscuring an advertisement" — so it
 * carries more terms-of-service exposure than the rest of the product combined.
 */
export const DEFAULT_SETTINGS: Settings = {
  axes: {
    engagement_bait: { mode: 'enabled', threshold: 70 },
    ai_written: { mode: 'enabled', threshold: 90 },
    ai_image: { mode: 'off', threshold: 85 },
    sponsored: { mode: 'enabled', threshold: 90 },
  },
  allowlist: [],
  retentionDays: 90,
  shadowMode: false,
}
