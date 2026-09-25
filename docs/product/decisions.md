# Decision log

Append-only. Superseding an entry means adding a new one that says so — never editing the old one.
The wrong turns are worth keeping; they stop the next person retaking them.

Format: **ADR-NNN — Title** · date · status · decision · why · alternatives rejected.

---

## ADR-001 — Target AI-written prose and engagement bait, not AI as a topic
**2026-09-25 · Accepted**

We hide posts based on *how they were written*, not what they are about. A human-written essay
analysing LLMs stays in the feed. A generated post about supply-chain logistics does not.
Engagement bait is a separate, independently-toggleable axis. AI-generated images are a third axis,
deferred to phase 3 but architecturally present from day one.

**Why:** topic-based filtering is a keyword blocklist wearing a costume, and it would hide exactly
the thoughtful commentary worth reading. Style is the actual complaint.

**Rejected:** filtering posts that mention AI — trivially implementable and comprehensively wrong.

---

## ADR-002 — On-device inference, inside the extension
**2026-09-25 · Accepted**

Classification runs in the browser via WebGPU. Not on a server, and not via a local companion app
(Ollama, LM Studio) reachable over `localhost`.

**Why:** the privacy claim has to be structural, not a promise — there is no endpoint to leak to.
In-extension also means zero install friction beyond the extension itself.

**Rejected:**
- *Remote API* — cheapest to build, best quality, and fatal to the entire premise. What you read
  is the most sensitive thing about you.
- *Local Ollama server* — genuinely better models and a clean "click to install" UX mapping onto
  Ollama's registry, but requires installing a separate desktop app. An adoption cliff most users
  will not climb for a feed filter.

---

## ADR-003 — Chrome's built-in Gemini Nano is the default; WebLLM models are upgrades
**2026-09-25 · Accepted**

First run uses Chrome's built-in Prompt API, which requires no download. The model manager offers
larger WebLLM models as optional, explicitly-chosen upgrades, with a recommendation derived from
the machine's specs.

**Why:** a mandatory ~1GB download before the extension does anything visible is where most users
quit. Starting with the built-in model makes "install a better model" a genuine upgrade with
observable benefit rather than a toll gate.

**Rejected:**
- *WebLLM only* — one code path and full control, but every user waits for a gigabyte first.
- *Fine-tuned encoder classifier (DistilBERT-class)* — the right shape for this task at ~100MB and
  milliseconds per post. No off-the-shelf checkpoint exists for "LinkedIn slop" and we have no
  labelled data. Revisit once ADR-008's feedback corpus exists; this is the natural v2.

---

## ADR-004 — Heuristics triage, they never judge
**2026-09-25 · Accepted**

A cheap in-tab scorer runs on every post and classifies it into `clean` / `ambiguous` /
`likely-slop`. That band decides **only** whether the post is worth sending to the model. It never
produces a hide decision on its own.

**Why:** running a 1-2B model over 200 posts per scroll session is real battery and real latency;
triage cuts inference by roughly 3-4x. But regex-grade rules are not accurate enough to hide
someone's content, and a rules-only fallback would quietly punish non-native English speakers and
anyone who writes tidily. Separating *router* from *judge* gets the performance win without the
accuracy cost.

**Consequence:** combined with ADR-005, an extension with no working model hides nothing at all.
This is intentional and the two decisions must be read together.

---

## ADR-005 — Fail open
**2026-09-25 · Accepted**

No WebGPU, model not downloaded, download in progress, unsupported hardware, inference error: hide
nothing, and surface the state in the popup.

**Why:** the cost of a false positive — hiding a post someone wanted — is much higher than the cost
of showing slop. An unfiltered feed is the status quo, not a failure. Degrading to crude rules
would mean a user's experience silently gets *worse* accuracy without them knowing.

Implemented as a state machine (`uninitialized → checking → downloading → ready → degraded`),
not a boolean. Only `ready` may collapse a post.

**Rejected:** heuristics-only degraded mode (contradicts ADR-004); blocking the feed until setup
completes (hostile, and punishes users on unsupported hardware who can never complete it).

---

## ADR-006 — Collapse to a one-line stub, never remove
**2026-09-25 · Accepted**

A hidden post becomes a thin bar: author, confidence, triggering axis, and a Show control.

**Why:** three reasons, in order. Recovery — a false positive is one click from being read.
Trust — you cannot calibrate confidence in a classifier whose mistakes are invisible to you.
Honesty — a tool that makes things vanish is asking for faith it has not earned.

**Rejected:** full DOM removal (cleanest feed, zero feedback loop, indistinguishable from a bug);
blur-on-hover (keeps full post height, so you still scroll the same distance — most of the win lost).

---

## ADR-007 — v1 is LinkedIn, the dashboard, and the creator leaderboard
**2026-09-25 · Accepted**

One site, done completely, including the dashboard and repeat-offender list. Reddit, ad filtering,
and bulk unfollow are explicitly out.

**Why:** the dashboard is not a nice-to-have — without it there is no way to answer "is this thing
any good?", which is the only question that matters early. Adding Reddit in v1 would split tuning
attention across two very different feeds before either is calibrated.

**Rejected:** filtering-only v1 (ships faster, produces no evidence); LinkedIn + Reddit (proves the
adapter seam early, but at ~40% more work and halved tuning focus — the seam is cheap to honour
without a second implementation); including bulk unfollow (see ADR-011).

---

## ADR-008 — Collect local ground truth from day one
**2026-09-25 · Accepted**

Every verdict carries a 👍/👎 affordance. Labels are stored locally as
`{postId, axis, userSays, verdictAtTime}` and power the dashboard's accuracy stat and threshold tuning.

**Why:** cheap now, expensive to retrofit, and it is the only path to answering whether detection
works. It is also precisely the corpus a v2 fine-tuned classifier needs (see ADR-003).

Export is opt-in, explicit, and clearly worded, because exporting labels means exporting post text.

---

## ADR-009 — The model lives in a persistent offscreen document
**2026-09-25 · Accepted** — alternatives eliminated by evidence; chosen option pending spike S2

A single `chrome.offscreen` document hosts one shared model instance. Content scripts message into
it via the service worker. One instance for the whole browser, not one per tab.

**Every alternative is now eliminated on evidence, which is stronger than the original reasoning:**

- *Service worker* — impossible, not merely awkward. `LanguageModel` is exposed to Window contexts
  under `RuntimeEnabled=AIPromptAPI` but to Worker contexts only under the separate
  `AIPromptAPIForWorkers`, which is declared in the Chrome 153 binary with no `status` field (off by
  default everywhere) and **has no `chrome://flags` entry**. There is no user-flippable escape
  hatch. Chrome's own extension docs say "The Prompt API isn't available in Web Workers for now."
- *Content script* — three independent reasons. Inference would be attributed to LinkedIn's origin;
  `language-model` is a real `Permissions-Policy` token in Chrome 153, so **LinkedIn could disable
  it with one response header**; and a per-tab session multiplies a multi-gigabyte model.
- *Extension page* — viable but requires a tab to stay open. Retained for one specific job: it is
  the only context that can supply the user gesture `create()` demands (ADR-013).

**Still unconfirmed:** whether `LanguageModel` and `navigator.gpu` actually work *inside* an
offscreen document. That is spike S2, and it gates the WebLLM tier entirely. The mitigation is
structural rather than speculative — a message boundary at `classify(posts) → verdicts` means
nothing upstream knows where inference runs, so relocating the host is a one-file change.

Consequence recorded in ADR-015: this design does not port to Firefox or Safari.

---

## ADR-013 — First run forces a model choice; Gemini Nano is not a zero-download default
**2026-09-25 · Accepted · supersedes ADR-003**

ADR-003 was built on a false premise — mine. Gemini Nano is **not** bundled with Chrome. It is a
component-updater download measured at **4,269,932,544 bytes** (`weights.bin`, verified on disk)
plus a separate ~120 MB safety classifier, gated on detected VRAM and two free-disk thresholds, and
disableable by the `GenAILocalFoundationalModelSettings` enterprise policy. Decisively,
`create()` **requires a transient user gesture** whenever availability is `"downloadable"` or
`"downloading"` (Blink: `Requires a user gesture when availability is "downloading" or "downloadable".`).

So there is no free default, and every model path costs a large download. Onboarding therefore
makes the choice explicit: on first run the user picks a model and installs it, from the dashboard,
behind a click. Until then the extension hides nothing and says so.

**Structural consequences:**
1. A model download can only ever be initiated from an extension page — not the service worker, not
   the offscreen document, neither of which can supply a gesture.
2. Because a WebLLM 1.5B model is roughly 1 GB against Nano's 4.27 GB, **Nano is not automatically
   the lightest option.** It is still the recommended first choice — it is shared across all of
   Chrome rather than costing us private storage, and it avoids the unresolved remote-hosted-code
   question hanging over WebLLM (brief R10) — but the model picker must show real sizes and let the
   user judge.
3. Hardware-gating and enterprise-policy blocking are **indistinguishable** from an extension; both
   surface as `"unavailable"` forever. The copy must cover both causes and point at
   `chrome://on-device-internals`.

**Rejected:** heuristics hiding on both axes until a model arrives (abandons ADR-004's protection
against penalising non-native English writers); a narrow high-precision heuristic that may hide
engagement bait only (defensible, and reconsider if install-to-activation conversion is poor, but it
reintroduces rules-that-hide through a side door); holding the line at model-or-nothing with no
onboarding push (honest, but leaves most installs silently inert).

---

## ADR-014 — `chrome.storage.sync` is banned
**2026-09-25 · Accepted**

Settings live in `chrome.storage.local`; post history and aggregates live in IndexedDB, written
solely by the offscreen document. `chrome.storage.sync` is not used anywhere.

**Why:** `sync` uploads to Google's servers. However convenient cross-device settings would be, it
would make ADR-002's "nothing leaves the machine" claim false. The guarantee has to be structural.

---

## ADR-015 — Cross-browser means the UI shell, not the model layer
**2026-09-25 · Accepted**

WXT is the toolchain and the content script, adapter, extraction, triage router, stub UI, storage
and dashboard all port. **The model layer does not port to anything.**

- **Firefox** has WONTFIX'd `chrome.offscreen` (Bugzilla 1807830 — Mozilla's position is that event
  pages already have a DOM), ships WebGPU as `partial_implementation: "Supported on Windows only"`,
  and has no Prompt API. Its MV3 background *is* a DOM page, so the engine can live there directly —
  the asymmetry works in our favour — but Firefox is WebLLM-or-nothing, and WebLLM is Windows-only
  until bug 2006676 lands.
- **Safari** has neither offscreen documents nor a JS-reachable on-device model; Apple's
  `FoundationModels` is a Swift framework reachable only through a native-messaging hop to a
  container app. Safari is a second implementation, not a port, and is scheduled last.

**Why record this:** the roadmap said "Chrome, then Firefox, then Safari" as though it were a
porting exercise. It is not, and planning on that basis would be planning on a fiction.

---

## ADR-016 — Bulk unfollow ships as a separate extension, not a feature of this one
**2026-09-25 · Accepted · extends ADR-011**

When the unfollow feature eventually ships, it ships under its own extension ID and its own store
listing. It is never added to this package.

**Why:** the two products have incompatible risk profiles. This extension only reads and hides,
locally — a defensible position against LinkedIn's User Agreement and an easy Chrome Web Store
review. An extension that performs write actions on a third-party site is a different conversation
with both, and a rejection or takedown there must not be able to take the filter down with it.
Separate IDs make that blast radius explicit.

---

## ADR-017 — pnpm is required; npm cannot install this project
**2026-09-25 · Accepted**

**Why:** not a preference. `npm install` fails outright with
`TypeError: Cannot read properties of null (reading 'edgesOut')` in arborist's `#loadPeerSet` while
resolving vitest's optional peers (`@vitest/browser`, `@vitest/ui`). Reproduced on npm 10.9.2 /
node 23.11.0 after a full cache clean. pnpm 12.6.0 installs the same tree in 9 seconds.

Recorded as a decision rather than a note because a future agent hitting that error will otherwise
waste time assuming the dependency list is wrong.

---

## ADR-010 — Verdicts are multi-axis, not boolean
**2026-09-25 · Accepted**

A verdict carries an independent score per axis (`ai_written`, `engagement_bait`, `ai_image`,
`sponsored`) with the source of each signal, plus `engineId` and `rulesVersion`.

**Why:** three payoffs from one shape. Users can hide slop while keeping engagement bait. Adding
sponsored-content filtering in phase 2 touches no pipeline code. And keying the verdict cache on
`postId + textHash + rulesVersion + engineId` makes cache invalidation automatic when heuristics
change or the user switches model — there is no manual bust to forget.

---

## ADR-011 — Bulk unfollow ships last, and never without confirmation
**2026-09-25 · Accepted**

Unfollow and disconnect are deferred to phase 4, gated on the classifier having demonstrated
accuracy against real feedback, and always require explicit per-action confirmation.

**Why:** the action is irreversible, driven by a classifier that will be wrong sometimes, and
carries genuine LinkedIn account risk. Shipping it alongside an untuned classifier would mean
users irreversibly severing professional connections on the word of a 1B-parameter model.

The v1 substitute is local-only muting, which achieves the same feed outcome with zero risk and
full reversibility.

---

## ADR-012 — Feature work is tracked in `docs/features/NNN-slug/`
**2026-09-25 · Accepted**

Every feature gets a numbered folder with `plan.md` and a living `checklist.md` before code is
written. Agents update the checklist on completion *and* on discovery of new work.

**Why:** this repo will be worked on by agents across many sessions with no shared memory. The
checklist is the handoff. The discovery half matters more than the completion half — a checklist
that only shrinks is hiding what was found and not written down.

See `AGENTS.md` for the binding version.
