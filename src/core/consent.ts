/**
 * The consent gate, as a pure state machine (ADR-020).
 *
 * Two independent conditions must both hold before we may read a single post: the user has
 * affirmatively consented in our UI, and Chrome still grants the LinkedIn host permission. They
 * can diverge — a user can revoke the permission in `chrome://extensions` without touching our
 * settings — so both are checked, and neither is inferred from the other.
 *
 * Pure and platform-free, so the rule is testable without a browser.
 */

export type GateState =
  /** No consent recorded. Onboarding has not been completed. */
  | { status: 'needs_consent' }
  /** Consented, but Chrome does not (or no longer does) grant the host permission. */
  | { status: 'needs_permission' }
  /** Both conditions hold. The content script may be registered. */
  | { status: 'active' }

export interface GateInput {
  hasConsent: boolean
  hasHostPermission: boolean
}

export function gateState(input: GateInput): GateState {
  // Consent is checked first so the reported state names the thing the user should act on. A
  // user who has not consented does not need to be told about a permission.
  if (!input.hasConsent) return { status: 'needs_consent' }
  if (!input.hasHostPermission) return { status: 'needs_permission' }
  return { status: 'active' }
}

/**
 * The single question the service worker asks. Deliberately a function rather than an inline
 * `=== 'active'` comparison, so adding a future state cannot silently start granting access.
 */
export function mayReadPosts(state: GateState): boolean {
  return state.status === 'active'
}

/** Copy for the onboarding UI. Kept here so the states and their explanations cannot drift. */
export const GATE_COPY: Record<GateState['status'], { title: string; detail: string }> = {
  needs_consent: {
    title: 'Reclaim needs your permission to read your feed',
    detail:
      'To tell which posts are worth hiding, Reclaim reads the text of posts in your LinkedIn feed. ' +
      'This happens entirely on your device — nothing is uploaded, and there is no account. ' +
      'A short excerpt of each post is stored locally so you can see what was hidden, and you can ' +
      'delete all of it at any time.',
  },
  needs_permission: {
    title: 'Reclaim no longer has access to LinkedIn',
    detail:
      'Chrome is not granting access to linkedin.com, so nothing is being filtered. ' +
      'This usually means the permission was revoked from the extensions page.',
  },
  active: {
    title: 'Reclaim is active',
    detail: 'Reading your feed on this device only.',
  },
}
