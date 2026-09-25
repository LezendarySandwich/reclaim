# Architecture overview

The validated design. Decisions behind it are in `../product/decisions.md`; externally-verified
facts about Chrome, WebGPU and LinkedIn are in `technical-brief.md`.

> **Status:** the execution-context layout below assumes WebGPU and the Prompt API are usable from
> a `chrome.offscreen` document. That is ADR-009 and is provisional pending verification. If it
> fails, the model host moves, but nothing else in this document changes — which is the point of
> the seams.

## System

```
content script (one per LinkedIn tab)
   MutationObserver → SiteAdapter.extract(post)
   → heuristic triage  (<1ms, in-tab, routes only)
   → ambiguous? ──────────────────┐
   → render: collapsed stub + 👍/👎
                                  │
service worker (MV3)              │   router · sole writer to storage
   keeps offscreen doc alive · settings · no WebGPU, never blocks
                                  │
offscreen document (persistent) ◄─┘   the only WebGPU context
   ModelEngine: GeminiNano | WebLLM
   request queue · batching · cancellation
                                  
extension pages (React)
   popup: toggle, session count, state badge
   dashboard: history, metrics, creator leaderboard, model manager, settings
```

**One model instance for the whole browser**, shared by every LinkedIn tab — not one per tab. This
is the main reason the model does not live in the content script.

The service worker never touches WebGPU and never blocks on inference. It routes messages and is
the single writer to IndexedDB, so concurrent tabs cannot race each other.

## The four seams

Each axis the product extends along gets an interface, so extension is a new file rather than a
refactor.

| Seam | Interface | Extends along |
|---|---|---|
| `SiteAdapter` | `matches(url)`, `findPosts(root)`, `extract(el) → Post`, `mount(el, verdict)` | New sites — Reddit is a new directory under `src/adapters/` |
| `Detector` | `score(post) → Partial<Verdict>` | New signals. Heuristic and model are both Detectors; results merge |
| `ModelEngine` | `availability()`, `load(onProgress)`, `judge(post, signal) → Scores`, `unload()` | New backends, plus the model registry carrying size, RAM/VRAM needs and quality tier |
| `ImageSignalProvider` | `inspect(media) → {source, confidence, evidence}` | Phase 3. Stubbed in v1 so the pipeline shape is already right |

Site-specific selectors live in `src/adapters/<site>/` **and nowhere else**. A grep for
`feed-shared-update` outside that directory is a bug.

## Detection pipeline

```
extract → Post {id, authorUrn, authorName, text, media[], isPromoted, isRepost}
   ↓
STAGE A · triage (in-tab, synchronous, <1ms)  → clean | ambiguous | likely-slop
   ↓  (ambiguous and likely-slop only)
STAGE B · model judge (offscreen, batched, cancellable)
   ↓
merge → Verdict → collapse or show
```

Stage A is a **router, not a judge** (ADR-004). It decides what is worth spending inference on and
nothing else. Its thresholds are tuned for high recall into `ambiguous` — being unsure is cheap,
and `clean` is only returned when the scorer is confident.

```ts
type Axis = 'ai_written' | 'engagement_bait' | 'ai_image' | 'sponsored'

type Verdict = {
  postId: string
  signals: Partial<Record<Axis, {
    score: number                                  // 0-100
    source: 'heuristic' | 'model' | 'metadata'
  }>>
  action: 'show' | 'collapse'
  engineId: string        // which model decided
  rulesVersion: string    // heuristic + prompt version
}
```

`action` is `collapse` when any **enabled** axis exceeds its user-set threshold. Axes are
independently toggleable, so "hide slop, keep engagement bait" is a setting rather than a fork.

### Why this shape

**Cache invalidation is free.** Verdicts are keyed on `postId + textHash + rulesVersion + engineId`.
Scrolling past the same post twice costs no second inference; shipping new heuristics or switching
model invalidates every stale verdict automatically. There is no manual bust to forget.

**Backpressure is built in.** Only posts within N viewports are scored. Scrolling past cancels
in-flight work through an `AbortSignal`, and concurrent inference is capped. A fast scroll through
200 posts must not enqueue 200 model calls.

**Fail-open is a state machine, not a flag.**

```
uninitialized → checking → downloading(pct) → ready → degraded(reason)
```

Only `ready` may collapse anything. The popup renders the current state, so "why isn't it hiding
things?" always has a visible answer.

## Feedback

Each verdict carries a 👍/👎 control writing `Label {postId, axis, userSays, verdictAtTime}`.
That is the denominator for the dashboard's accuracy figure and the tuning signal for thresholds —
and, eventually, the training corpus for a proper classifier (ADR-003, ADR-008).

## Dashboard

Full-page extension tab. The popup stays minimal: on/off, session count, state badge.

| Section | Contents |
|---|---|
| Overview | Hidden today / this week / cumulative, and accuracy computed from your own labels |
| Timeline | Last N hidden posts, expandable to original text with score, triggering axis, and a "this was wrong" control |
| Creators | The leaderboard: author, posts seen, % flagged, mean confidence, trend |
| Models | Current engine, catalogue with size/RAM/quality, "recommended for your machine" badge, download and delete |
| Settings | Per-axis toggles and thresholds, creator allowlist, retention window, JSONL export |

The leaderboard sorts by **rate × volume**, not raw flag count, so a prolific but clean poster does
not top the list and a single bad post does not brand someone a repeat offender.

## Repository layout

```
reclaim/
├── AGENTS.md                  # contract for future agents — read first
├── docs/
│   ├── README.md
│   ├── product/               # vision.md, decisions.md
│   ├── architecture/          # overview.md, execution-contexts.md, technical-brief.md
│   └── features/NNN-slug/     # plan.md + living checklist.md
├── src/
│   ├── core/          # types, verdict merge, thresholds — zero platform deps, node-testable
│   ├── detect/        # heuristics, prompts
│   ├── engines/       # gemini-nano, webllm, registry, hardware specs
│   ├── adapters/      # linkedin/   (reddit/ later)
│   ├── storage/
│   └── entrypoints/   # content, background, offscreen, popup, dashboard — wiring only
└── tests/
```

## Data flow, end to end

1. LinkedIn renders a post. `MutationObserver` in the content script fires.
2. `LinkedInAdapter.extract()` produces a `Post`. Already-scored posts are skipped by cache key.
3. Stage A triage runs in-tab. `clean` → done, post renders untouched.
4. Otherwise the content script asks the service worker, which relays to the offscreen document.
5. The offscreen document queues the request, batches it, and runs `ModelEngine.judge()`.
6. The verdict returns to the content script, which mounts a collapsed stub or leaves the post alone.
7. The service worker writes the verdict and updates the author aggregate in IndexedDB.
8. Dashboard reads aggregates; it never recomputes from raw history.
