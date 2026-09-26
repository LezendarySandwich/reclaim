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

---

## ADR-018 — The Prompt API engine lives in the service worker, not the offscreen document
**2026-09-26 · Accepted · VERIFIED IN A REAL SERVICE WORKER · supersedes ADR-009 for the Gemini Nano path**

> **Confirmed empirically 2026-09-26.** Run from the extension's own service-worker console on
> Chrome 153:
> ```
> context                   ServiceWorkerGlobalScope
> LanguageModel present     YES
> availability()            downloadable
> ```
> The Chromium source reading below was correct. This was the single largest unverified assumption
> in the build, and the model layer is in the right place.
>
> One surprise: `LanguageModel.params()` returned **undefined** in that same context. Either
> params are unknowable before the model is downloaded, or this build has legacy sampling params
> off — indistinguishable from outside. The engine now tries `temperature: 0, topK: 1` and falls
> back to default sampling if `create()` rejects them, rather than dying. See ADR-024.

ADR-009 was backwards. It rested on "the Prompt API is unavailable in MV3 service workers", which
is wrong for extensions, and the correction inverts which context is privileged.

`chrome_content_renderer_client.cc` force-enables `AIPromptAPIForWorkers` for any renderer launched
with `--extension-process`, under the comment "These Web API features are exposed in extensions".
MV3 service workers run in the extension's own renderer process, so `LanguageModel` is available
there. And the user-gesture gate is `if (window && RequiresUserActivation(availability) && …)` —
`LocalDOMWindow::From()` is null in a worker, so the check is skipped entirely, while an **offscreen
document is a Window with a frame that can never receive user input** and therefore can *never*
call `create()` while availability is `"downloadable"`.

| Context | `LanguageModel` | `create()` when `downloadable` |
|---|---|---|
| Service worker | ✅ | ✅ no gesture needed |
| Extension page | ✅ | ✅ with a real click |
| Offscreen document | ✅ exposed | ❌ never |

**Decision:** Prompt API engine in the service worker. The offscreen document is retained **only**
for WebLLM, which genuinely needs it (service workers lack WASM/Workers/Atomics). Two backends,
two hosts — so the `classify(posts) → verdicts` message boundary must keep the host a one-line swap.

Corroborating: a GitHub search for `chrome.offscreen` + `LanguageModel` returns zero results, and
Google's own samples use the service worker or a side panel, never offscreen.

**Unresolved, and it is the one argument left for offscreen:** service workers die after ~30s idle
and sessions do not survive. `create()` cost on wake is real and unmeasured — spike A2.

**Also:** downloads still start from an extension page behind a real click. The service worker
*can* do it gesture-free, but a multi-gigabyte download deserves explicit consent. Treat the
gesture rule as a UX floor we choose to honour, not a constraint to route around.

---

## ADR-019 — `engagement_bait` ships default-on; `ai_written` ships shadow-only
**2026-09-26 · Accepted · refines ADR-001**

`ai_written` is scored and recorded but hides nothing in v1. It is exposed only as an opt-in,
off-by-default experimental toggle with an explicit unreliability panel. `engagement_bait` is the
default-on axis.

**Why — the literature is not close:**
- At 50 tokens, published zero-shot detectors score AUC 0.16–0.73; perplexity and DetectGPT are
  frequently *below chance*. Our range is 50–400 words.
- On the balanced READER benchmark, prompted frontier models score 0.53–0.73 accuracy against a
  0.50 chance baseline. A **fine-tuned** 1.5B model scores 0.953. The constraint is the training
  objective, not parameter count — a prompted Gemini Nano will not beat 0.73.
- Liang et al. measured a **61.22% false-positive rate** on TOEFL essays across seven commercial
  detectors, and a 2026 mechanistic paper shows this is structural: detectors "rate the median
  formal-native human essay as 99.5% likely AI". LinkedIn is the most formal-register platform
  there is. This is our dominant failure mode, not an edge case.

Engagement bait is a different kind of problem — the text states its own intent ("comment YES for
the template"), the user can verify a flag instantly, and a false positive is embarrassing rather
than defamatory. Lead with the axis we can actually deliver.

**Consequences:**
- Never render a confidence percentage. Detectors are badly calibrated out of distribution and
  OpenAI specifically warned they become "extremely confident in a wrong prediction".
- Never phrase a verdict as a factual claim about a named person's post. "Looks templated", not
  "AI-written".
- The leaderboard must never name a creator on the `ai_written` axis alone. It is an accusation
  surface by construction, and the evidence says we would aim it disproportionately at non-native
  English speakers.
- `ai_written` should eventually be ternary — human / assisted / generated — and hide only
  "generated". The modal LinkedIn post is human content run through an assistant.
- Thumbs feedback closes the loop for `engagement_bait` only. For `ai_written` it is an
  *annoyance* label: a 25M-comment study found human AI-accusations uncorrelated with the actual
  statistical signal, so auto-tuning on thumbs would train a "posts I find annoying" classifier
  and then label its output "AI-written".
- Thresholds are per-word-count bucket, never one global scalar.

Default-on `ai_written` needs a fine-tuned small classifier, not a better prompt. That is a
roadmap item, not a tuning task.

---

## ADR-020 — Consent gate before any post text is read
**2026-09-26 · Accepted**

No content script runs, and no post text is read, until the user has given an affirmative in-product
consent. Implementation: register the content script **dynamically** via `chrome.scripting` after
consent, not statically in the manifest, and request the LinkedIn host permission as an
**optional** permission during onboarding rather than at install.

**Why:** the Chrome Web Store User Data policy changed in July 2026 (confirmed by Wayback-diff;
landed 2026-06-28 → 2026-07-03). Google deleted the qualifier "personal or sensitive" from "user
data" throughout, added an FAQ entry stating local-only storage still requires disclosure, and
**deleted the exemption** for data handling "closely related to functionality described
prominently". Under the old rules we were exempt. We are not now. A static `content_scripts` entry
handles user data pre-consent.

Also required: a live privacy-policy URL and the Limited Use statement. Storing everything locally
does not avoid any of this.

---

## ADR-021 — Zero network requests to linkedin.com, ever
**2026-09-26 · Accepted**

We read only what the page has already rendered. No `fetch`, no Voyager API, no prefetch, no
speculative expansion of truncated text via the network.

**Why, and it is two reasons.** LinkedIn's "Prohibited software and extensions" page bans, verbatim,
"browser extensions that scrape, modify the appearance of, or automate activity on LinkedIn's
website", and UA §8.2 names "Overlay or otherwise modify the Services or their appearance". There
is no display-only carve-out — v1 breaches the UA and no reading of the text avoids that. The
remedy runs against **the member's account**, not us.

So the risk is borne by our users, which makes minimising it an obligation rather than a
preference. A purely passive DOM reader is close to undetectable server-side. One extra XHR is a
fingerprint. This is an architectural commitment, and any future feature that wants a network call
to LinkedIn needs a new ADR that argues past this one.

We also disclose it plainly in onboarding rather than burying it — see `docs/product/vision.md`.

(For the record, `hiQ v. LinkedIn` is not the shield it is usually cited as: the CFAA holding
survives but the district court held hiQ breached the UA as a matter of law, ending in a $500,000
consent judgment and a permanent injunction.)

---

## ADR-022 — WebLLM for the optional tier; transformers.js is rejected
**2026-09-26 · Accepted · refines ADR-003**

**Remote-hosted code:** model *weights* are data, not code — Chrome's RHC guidance says "It does
not include data". Defensible. **WASM from a CDN is categorically a violation**, and MV3's CSP will
not let us allowlist one. Both libraries fetch WASM from a non-extension origin by default, so both
need a build-time fix.

WebLLM's fix is cheap: vendor the per-model `*-webgpu.wasm` (~5.3 MB each) and point `model_lib` at
a relative path — `engine.ts` already has a non-http branch. Transformers.js needs ~27 MB of
vendored onnxruntime WASM plus a `wasmPaths` override merely to be legal, and its default points at
remote JavaScript on jsDelivr, which is the most clear-cut violation possible.

**Rejected on merits too, not just packaging.** The best available detector checkpoint
(`onnx-community/tmr-ai-text-detector-ONNX`, 126 MB int8) is trained on news/Wikipedia/Reddit and
its own model card warns of elevated false positives on "casual conversation, short text" — i.e.
LinkedIn posts. A binary human/AI classifier also cannot produce the one-line reason the collapsed
stub promises, and no public checkpoint covers engagement bait at all, which is half the product.

Default model `Qwen3-0.6B-q4f16_1-MLC` (~350 MB download, 1403 MB VRAM), laddering to
`Qwen2.5-1.5B-Instruct-q4f16_1-MLC` and `Llama-3.2-3B-Instruct-q4f16_1-MLC`. Gate on
`vram_required_MB`, **not** `low_resource_required` — that flag is true even for an 8B model.

If we later want a cheap always-on scorer, the better move is WebLLM's own embedding tier plus a
classifier head trained on our own feedback data. Same stack, no second runtime.

---

## ADR-023 — Selectors ship as a remotely-updatable config that fails closed
**2026-09-26 · Accepted**

LinkedIn's modern feed uses 8-hex build-hash class names that change every deploy, and a maintained
comparable project shows a selector-affecting fix every 1–3 weeks. A Chrome Web Store update per
fix is not viable, so selectors live in a JSON config fetchable from our own origin.

**This is the one sanctioned outbound request, and it is tightly bounded:**
- To our origin only — never LinkedIn (ADR-021).
- It **sends nothing**. No query parameters, no identifiers, no version telemetry, no cookies. A
  static file fetch, indistinguishable between users.
- It **fails closed** to the selectors bundled in the extension. A fetch failure must never mean
  "hide nothing incorrectly" or "hide the wrong thing" — it means we run on last-known-good.
- Config is data, never code. No expressions, no callbacks, no `eval`. A schema check rejects
  anything else — this is also what keeps us on the right side of the remote-hosted-code rule.

This narrows ADR-002's "nothing leaves the machine": nothing *about the user* leaves. A static
config download carries no information about them. If that ever stops being true — a version
parameter, an install ID, anything — it needs a new ADR.

**Consequence:** because the extension hides nothing without a model, a broken selector and a
missing model look identical to the user. Instrument the difference: ship a stale-selector sentinel
that detects "feed root found, zero posts matched" and surfaces it distinctly.


---

## ADR-024 — Greedy decoding is best-effort, and its absence is surfaced
**2026-09-26 · Accepted**

The engine asks for `temperature: 0, topK: 1`. If `create()` rejects those options it retries
without them rather than failing, and exposes `isDeterministic === false`.

**Why this is not just defensive coding.** Greedy decoding is what makes a post's verdict
reproducible. Without it:

- the verdict cache becomes misleading — the same post genuinely could have scored differently,
  so a cached verdict is not "the answer" but "an answer";
- threshold calibration from shadow data measures sampling noise as well as signal;
- a user who expands a post and sees it re-collapse differently has no explanation.

So this is not a silent degradation. The dashboard must say that scores are unstable on this
device, and calibration must not treat such data as clean.

**Why the retry is narrow.** `isLikelySamplingRejection` only matches `NotSupportedError`,
`TypeError`, or a message naming the sampling options. A blanket retry-on-any-error would mask a
model that genuinely cannot load, which should surface as `degraded` rather than quietly failing
twice.

**Prompted by observation, not theory:** `LanguageModel.params()` returned `undefined` in a real
extension service worker on Chrome 153 while availability was `"downloadable"`. The research said
extensions retain legacy sampling params; that may still be true and params may simply be
unknowable before download. Rather than resolve it from outside, the code is correct either way.

---

## ADR-025 — `ai_written` hides, but only at the top rung
**2026-09-26 · Accepted · amends ADR-019 · user decision**

`ai_written` moves from `shadow` to `enabled` with a threshold of **90**.

The model answers on a six-rung ladder mapped to `none=0, slight=15, some=38, clear=65,
strong=85, blatant=97`. A threshold of 90 means **only `blatant` hides** — "strong" is not
enough. That is the narrowest possible reading of "high confidence", and it is narrow on purpose.

**Why not lower.** ADR-019's evidence has not changed: at post length published detectors score
AUC 0.16–0.73, prompted frontier models manage 0.53–0.73 against a 0.50 baseline, and Liang et al.
measured a 61.22% false-positive rate on non-native English writers. LinkedIn is the most
formal-register platform there is. One rung is the entire safety margin between this and the
failure mode the literature predicts.

**What this does NOT change:**

- **Heuristics still may never hide on this axis** (ADR-004). Regex-grade rules for AI authorship
  are a proxy for "non-native or formal writer"; enabling the axis does not enable them.
- **Thumbs on `ai_written` remain an annoyance label, not a tuning signal** (ADR-019 point 8). A
  25M-comment study found human AI-accusations uncorrelated with the statistical signal, so
  auto-tuning on them would train a "posts I find annoying" classifier and mislabel its output.
- **The stub still says "Looks templated"**, never "AI-written", and still renders no score. We
  are describing how text reads, not making a provenance claim about a person.

**Revisit if** the dashboard's `wouldHaveHidden` history or user disagreements suggest 90 is
mis-set. The number is a guess constrained by evidence, not a measurement — nobody has calibrated
a rung boundary against real feed data yet.

---

## ADR-026 — Promoted posts are hidden, and do not require a model
**2026-09-26 · Accepted · user decision · carves an exception to ADR-005**

`sponsored` moves from `off` to `enabled`, decides on a `metadata` signal, and is the **only**
axis that can hide with no working model.

**Why the carve-out is safe here.** Every other axis is a judgement about writing, which is why
ADR-004 keeps heuristics out of the decision and ADR-005 keeps everything behind the model gate.
`sponsored` is not a judgement: LinkedIn renders the word "Promoted" itself. There is nothing to
infer, nothing for a model to add, and none of the false-positive risk those decisions exist to
contain. Requiring a 4.27 GB download before the extension will hide an advert the page has
already labelled would be absurd.

The exception is deliberately narrow, expressed as two one-element sets in `verdict.ts`:
`METADATA_DECIDES` and `NEEDS_NO_ENGINE`. Adding an axis to either needs a new ADR. In particular
`ai_written` must never join them — a metadata path to collapse that bypasses the model is the
exact shape ADR-005 exists to prevent.

**The one real false-positive risk, and how it is handled.** "Promoted" is also what people say
when they get a new job. A substring match would hide *"I was promoted to Senior Engineer"* —
among the commonest posts on LinkedIn, and about the worst mistake this extension could make. So
the label must be a **line of its own** within the first eight lines of the post, matching a known
label exactly. Real ads render it standalone in the actor block; promotion announcements never do.
Three tests pin this.

**Terms-of-service exposure is higher here than anywhere else in the product, and this is a
considered acceptance rather than an oversight.** LinkedIn's User Agreement §8.2 names
"removing, covering, or obscuring an advertisement" explicitly — it is the single roadmap item
their terms call out by name, and the one most likely to be noticed because it touches revenue.
The earlier research recommended shipping it opt-in and off by default.

It ships on because the user asked for it on their own feed. What does not change: we still make
zero network requests to LinkedIn (ADR-021), so there is nothing server-side to detect; the post
is collapsed rather than removed, so the row stays in the layout; and the onboarding disclosure
already states that LinkedIn's terms prohibit appearance-modifying extensions.

**If this is ever distributed**, revisit: default it off, make enabling it an explicit choice, and
say plainly in the listing that it filters adverts.
