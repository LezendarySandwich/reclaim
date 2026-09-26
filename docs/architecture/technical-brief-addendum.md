# Technical brief — Addendum (curl-sourced pass)

**2026-09-25/26.** Covers the six dimensions the first research run could not complete, because its
web tools were policy-blocked. This pass reached primary sources via `curl`.

> **Provenance.** The workflow producing this died in its late verification stages after all six
> fetch agents completed. 97 findings and 108 verbatim quotes survived and are the basis of this
> document; 23 of a planned ~48 adversarial verifications ran. **Findings here are primary-sourced
> but only partly adversarially checked** — weaker than the §1–§11 brief on that axis. Treated
> accordingly below: claims traced to Chromium source or quoted policy text are relied on; claims
> resting on a single blog or repo are marked.

---

## 1. What changed — read this part

Three reversals. The first invalidates an ADR.

### 1.1 ADR-009 is backwards: the service worker is the privileged host

The first pass concluded the Prompt API is unavailable in MV3 service workers, because
`AIPromptAPIForWorkers` has `public: true` and no `status:` key in `runtime_enabled_features.json5`
— i.e. off by default. That reading was incomplete.

`chrome_content_renderer_client.cc`, in `SetRuntimeFeaturesDefaultsBeforeBlinkInitialization`:

```cpp
// These Web API features are exposed in extensions.
if (IsStandaloneContentExtensionProcess()) {
  blink::WebRuntimeFeatures::EnableAIPromptAPIForWorkers(true);
  blink::WebRuntimeFeatures::EnableAIPromptAPILegacyIdentifiers(true);
  blink::WebRuntimeFeatures::EnableAIPromptAPILegacyParams(true);
}
```

`IsStandaloneContentExtensionProcess()` tests for `extensions::switches::kExtensionProcess`, which
`chrome_content_browser_client_extensions_part.cc` appends for any process hosting an enabled
extension. **MV3 service workers run in the extension's own renderer process, so they get it.**
`LanguageModel` is available there.

Worse for the old plan, the user-gesture gate runs the other way round. `ai_utils.cc`:

```cpp
bool RequiresUserActivation(Availability availability) {
  return availability == Availability::kDownloadable;   // kDownloading is NOT included
}
```

and `language_model_create_client.cc`:

```cpp
LocalDOMWindow* window = LocalDOMWindow::From(script_state);
/* Prompt APIs are only available within window and extension worker contexts by default.
   User activation is not consumed by workers, as they lack the ability to do so. */
if (window && RequiresUserActivation(availability) && !MeetsUserActivationRequirements(window)) {
  RejectWithDOMException(kNotAllowedError, kExceptionMessageUserActivationRequired);
}
```

`LocalDOMWindow::From()` is null in a worker, so the check is skipped entirely. An **offscreen
document is a Window with a frame that can never receive user input**, so it fails the check and
can never call `create()` while availability is `"downloadable"`.

| Context | Prompt API | Can `create()` when `downloadable` |
|---|---|---|
| **MV3 service worker** | ✅ force-enabled for extension processes | ✅ no gesture needed |
| Extension page (options/popup) | ✅ | ✅ with a real click |
| **Offscreen document** | ✅ exposed | ❌ **never** — Window, no possible activation |
| Content script | ✅ nominally | ⚠️ page origin, page Permissions-Policy, no `params()` |

**Consequence:** the Prompt API engine goes in the **service worker**. The offscreen document is
kept for WebLLM only, which genuinely needs it (service workers lack WASM/Workers/Atomics).
Two backends, two hosts — so the `classify(posts) → verdicts` message boundary must make the host a
one-line swap. Corroborating: a GitHub search for `chrome.offscreen` + `LanguageModel` returns
**zero** results, and Google's own samples use the service worker or a side panel, never offscreen.

**The one argument left for offscreen:** service workers die after ~30s idle and sessions do not
survive. `create()` cost on wake is real and unmeasured. Measure before finalising.

Also corrected: the hardware floors the first pass called unsourced **are** documented verbatim —
"Strictly more than 4 GB of VRAM", "At least 22 GB of free space", a CPU fallback of "16 GB of RAM
or more and 4 CPU cores or more", and eviction if free space drops below 10 GB. The CPU fallback
materially widens eligibility.

### 1.2 `ai_written` cannot ship enabled — the literature is unambiguous

- **Short text is where detection dies.** At 50 tokens, published zero-shot detectors score
  AUC 0.16–0.73 — perplexity and DetectGPT frequently *below chance*. Short-text SOTA (Short-PHD,
  2025) reaches 0.73–0.87. OpenAI's withdrawn classifier was "very unreliable on short texts
  (below 1,000 characters)" — i.e. most of our 50–400-word range.
- **Prompting a general model is not detection.** On the balanced READER benchmark, Gemini-3-Pro
  scores 0.731, GPT-5.2 0.664, Qwen3-Max 0.530 — chance is 0.50. A **fine-tuned** 1.5B Qwen2.5
  scores 0.953 and holds >90% under 150 tokens. The constraint is the training objective, not the
  parameter count. A prompted Gemini Nano will not beat 0.73.
- **Non-native English speakers are the dominant failure mode.** Liang et al. measured a **61.22%
  false-positive rate** across seven commercial detectors on TOEFL essays. A 2026 mechanistic paper
  shows this is structural, not a calibration bug: detectors "rate the median formal-native human
  essay as 99.5% likely AI". LinkedIn is the most formal-register platform on the internet.
- **The em-dash signal is population-level, not per-document.** Human baseline 3.23 per 1,000 words;
  Gemini 2.5 Pro 3.53, Gemini 2.5 Flash 1.28, Llama 3.3 70B 0.00 — several models are *below*
  humans. Likelihood ratio at 200 words ≈1.85 vs GPT-4.1, ≈1.06 vs Gemini 2.5 Pro.
- **No client-side watermark signal exists.** SynthID's public detector is image/video/audio only;
  Anthropic's text detection is a gated private preview for regulators. Drop it from the roadmap.

**Therefore:** ship `engagement_bait` as the default-on axis and `ai_written` in shadow mode.
Engagement bait is a content/intent judgement the text states outright ("comment YES for the
template"), a user can verify instantly, and a false positive is embarrassing rather than
defamatory. This fully vindicates ADR-004 — heuristics for `ai_written` are not merely imprecise,
they are a proxy for "non-native or formal writer".

One tailwind: at high prevalence the arithmetic works. If Originality.ai's figure (81.2% of
long-form public LinkedIn posts Likely-AI, July 2026) is even half right, a 50%-recall/3%-FPR
detector yields ~98.5% precision. At 20% prevalence the same detector is wrong one time in two.
That is an argument for shipping *eventually*, after shadow mode gives us our own number.

### 1.3 The Chrome Web Store rules changed in July 2026, and it forces code changes

Found by Wayback-diffing; landed between 2026-06-28 20:15 UTC and 2026-07-03 15:24 UTC. Google:

- deleted the qualifier "personal or sensitive" from "user data" throughout;
- added an FAQ entry stating **local-only storage still requires disclosure**;
- **deleted the exemption** that let extensions skip prominent disclosure and affirmative consent
  when the data handling was "closely related to functionality described prominently".

Under the old rules we were exempt. **We are not any more.** Required: an in-extension prominent
disclosure with an affirmative click **before any post text is read**, a live privacy-policy URL,
and the Limited Use statement. Storing locally does not avoid any of it.

Structural consequence: **register the content script dynamically after consent** rather than
statically in the manifest, and request the LinkedIn host permission as an **optional** permission
during onboarding rather than at install. A static `content_scripts` entry handles user data
pre-consent.

---

## 2. Prior art — we are not reinventing, but we should steal

Nothing existing does model-gated filtering with a feedback loop and a local dashboard. Eight
projects are worth reading.

| Project | Approach | Take |
|---|---|---|
| `kimjune01/linkedin-slop-filter` | Gemini Nano Prompt API, one-line collapse stub | Closest precedent. Copy its lifecycle: `availability()` gate, needs-gesture sentinel, `monitor`/`downloadprogress`, **`base.clone()` per post**. Hosts the model in a MAIN-world content script — don't copy that |
| `Siriusbar/SlopedIn` | Persistent offscreen doc + Transformers.js | Copy the offscreen plumbing. Avoid: declares `reasons:['DOM_PARSER']` inaccurately, and renders a hard "87% AI" badge |
| `OdinMB/linkedin-detox` | Offscreen doc, local inference | Copy the stale-selector sentinel and its ToS disclosure in the listing |
| `adamnroman/slop-filter` | IntersectionObserver triage | **Copy the scan loop**: `rootMargin: '1500px 0px'` as the triage gate, MutationObserver coalesced through one rAF, dataset-id staleness check for recycled nodes |
| `lkclean` | — | **Copy the infinite-scroll kick.** You will hit this on day one |
| `deslopmyfeed` | — | Copy the 20-locale Promoted label list and the paste-in selector probe |
| `LinkOff` (3k users, the only one with distribution) | Keyword filter, no ML | Avoid: scans `post.outerHTML` with `indexOf` on a 350ms `setInterval` |
| `cringe-guard` | — | Avoid entirely: hardcodes a build-hash class, and POSTs every post the user reads to Groq |

**Do not write sponsored-post detection.** AdGuard Base (updated 2026-09-25) and EasyList carry
maintained LinkedIn rules including React-era `data-view-tracking-scope` and
`urn:li:sponsoredContentV2` anchors. uBlock's uAssets has one LinkedIn rule — AdGuard/EasyList is
the list to consume.

**Positioning:** the category is abandoned weekend projects. The moat is not the model — it is
selector-maintenance discipline and not making accusations we cannot back.

---

## 3. LinkedIn adapter — the DOM is mid-migration, and identity is the hard part

Two feeds are live simultaneously; today's AdGuard build ships rules for both.

| | Legacy (Ember) | Modern (React/SDUI) |
|---|---|---|
| Detect | `body.ember-application` | `body[data-rehydrated]`, `div[data-testid="mainFeed"]` |
| Classes | Semantic: `.feed-shared-update-v2` | **8-hex build hashes** (`_1d9c1239`), change every deploy |
| Post URN | `data-urn` / `data-id` = `urn:li:activity:…` | **None. At all.** |

In 10 real captured fixtures from a maintained filter project, the modern feed had not a single
`data-urn`, `data-id`, `data-activity-urn` or `data-chameleon-result-urn`.

**Never write a class-based selector for the modern feed.** Use attributes only. The anchors three
independent projects converged on:

```
[data-testid="mainFeed"]                              feed root
div[componentkey^="expandedFeedType_"][role="listitem"]   post row
div[componentkey="post-inner-key"]                    post content
[data-testid="expandable-text-box"]                   body text
[componentkey="author-name-key"]                      author
[componentkey="sponsored-indicator-key"]              sponsored
[componentkey="social-proof-bar-key"]                 EXCLUDE from text extraction
```

**Post identity is unsolved and blocks history, metrics and the leaderboard.** `componentkey`
values are semantic *template* keys (`body-key`) identical on every post — hashing them collides
across the whole page, which a prior-art repo (`jev-slop-guard`) actually does. Options in order:
(a) permalink `a[href*="/feed/update/"]` if rendered — may only appear after opening the control
menu; (b) the opaque per-instance `componentkey` seen on some cards — needs a cross-reload
stability check; (c) composite hash of author profile URL + normalised first ~400 chars + timestamp.
**S4 settles this.**

Two operational traps documented in shipped code:

1. **Empty slots.** Rows mount before content arrives (`data-lazy-mount-id`). Don't classify on
   first insert. Extends our fail-open rule: *no text → don't triage yet*.
2. **Hiding feed children kills infinite scroll** — LinkedIn's IntersectionObserver sentinel stops
   intersecting when the page never grows. Prefer collapsing height / replacing inner content over
   removing the row, and never `display:none` a child not positively identified as a post.

**Ship selectors as a remotely-updatable JSON config from day one.** `Hogwai/LinkedinSponsorBlock`'s
history shows a selector-affecting fix every 1–3 weeks; a store update per fix is not viable.
Watch EasyList `easylist_specific_hide.txt`, AdGuard `BaseFilter/sections/specific.txt`, and that
repo's commits as the earliest warning.

---

## 4. Model tier

**Remote-hosted code.** Model *weights* are data, not code — Chrome's RHC guidance says "It does
not include data", and MV3 requirements add that external resources "must not contain any logic".
Defensible. **WASM from a CDN is categorically a violation** and MV3's CSP won't let you allowlist
one. Both WebLLM and transformers.js fetch WASM from a non-extension origin by default.

**Ship WebLLM, drop transformers.js.** WebLLM's fix is cheap: vendor the per-model `*-webgpu.wasm`
(~5.3 MB each) and set `model_lib` to a relative path — `engine.ts` already has a non-http branch.
Transformers.js needs ~27 MB of vendored onnxruntime WASM plus a `wasmPaths` override just to be
legal, its default literally points at remote JavaScript on jsDelivr, and the best available
detector checkpoint (`onnx-community/tmr-ai-text-detector-ONNX`, 126 MB int8) is trained on
news/Wikipedia/Reddit with its own card warning of elevated FPR on "casual conversation, short
text". It also cannot produce the one-line reason the stub promises, and no public checkpoint
covers engagement bait at all — half the product.

`@mlc-ai/web-llm@0.2.85` (2026-09-08). Default **`Qwen3-0.6B-q4f16_1-MLC`** (1403 MB VRAM, ~350 MB
download), ladder to `Qwen2.5-1.5B-Instruct-q4f16_1-MLC` (1630) and
`Llama-3.2-3B-Instruct-q4f16_1-MLC` (2264). Gate on `vram_required_MB` against `navigator.gpu`
limits — **not** on `low_resource_required`, which is true even for an 8B model. Constrained
decoding is `response_format: {type: "json_object"|"grammar"|"structural_tag", schema}`. Weights
cache under `webllm/model` | `webllm/config` | `webllm/wasm`; there is no enumerate API, so the
dashboard loops `hasModelInCache` over our own list.

**Budget real time for the offscreen document: WebLLM has no offscreen example.** The repo's
example hosts the engine in the popup; a sibling uses a background SW. Adapting
`ExtensionServiceWorkerMLCEngineHandler`'s port pattern to `chrome.offscreen` is novel work.

Prompt API contract, all source-verified: `responseConstraint` + `omitResponseConstraintInput` are
stable, and schema text **counts against the context window unless omitted** — a RegExp constraint
never counts. Prompts on one session are **queued, not concurrent**; `clone()` is the parallelism
primitive. Context overflow **silently evicts oldest turns**, which argues for clone-per-post-and-
destroy so no state accumulates. `topK`/`temperature`/`params()` survive in extensions but are gone
from the web — take `temperature: 0, topK: 1`. **Image input is stable on desktop**, so phase 3
needs no new engine (use `ImageBitmap`/`Blob` in a worker; `HTMLImageElement` is not worker-safe).

---

## 5. Policy and legal

**LinkedIn has no display-only carve-out.** The "Prohibited software and extensions" page bans,
verbatim, *"browser extensions that scrape, modify the appearance of, or automate activity on
LinkedIn's website"*, and UA §8.2 names *"Overlay or otherwise modify the Services or their
appearance (such as by inserting elements into the Services…)"*. v1 is squarely inside it. This is
a contract breach, not a crime, and the stated remedy runs against **the member's account**, not
the developer.

**hiQ ended as a loss**, not the win it is usually cited as: the CFAA holding survives but is
limited to data "available to anyone with a web browser"; the district court then held on summary
judgment that hiQ breached the UA as a matter of law, ending in a $500,000 consent judgment and a
permanent injunction. LinkedIn is still actively litigating (v. Nubela/Proxycurl, N.D. Cal.
3:25-cv-00828, judgment 2025-07-25).

**The mitigation is architectural: make zero network requests to linkedin.com.** Never fetch, never
call Voyager, never prefetch — read only what the page already rendered. A purely passive DOM
reader is close to undetectable server-side; one extra XHR is a fingerprint. And disclose it in
onboarding in one plain sentence rather than burying it.

**Phase 3 ad filtering is the loudest item on the roadmap** — §8.2 names "removing, covering, or
obscuring an advertisement" explicitly, and it touches revenue. Do Reddit and images first; make ad
filtering opt-in and off by default if it ships at all.

---

## 6. Still unresolved

| # | Question | Settles it |
|---|---|---|
| A1 | Does `LanguageModel` actually work in our service worker, and can it `create()` gesture-free? Source-verified, zero documentation, and it reshapes the build. | 30-min smoke test; S2 harness already probes SW |
| A2 | `create()` cost on service-worker wake. The only remaining argument for the offscreen document. | Measure; decide keepalive vs lazy re-create |
| A3 | Post identity on the modern feed — permalink vs opaque componentkey vs composite hash | **S4** |
| A4 | Does the modern feed recycle DOM nodes? Decides whether `WeakMap<Element, state>` is safe at all | **S4** |
| A5 | Which feed build is this account on, and is it per-user? | **S4**, ideally on two accounts and both `?feedView=recent` and default |
| A6 | Chrome Web Store 2026-08-01 enforcement date — revision confirmed, enforcement date not reachable | Re-check before submission |
| A7 | WebLLM in an offscreen document — no prior art exists | Prototype before committing to the tier |
