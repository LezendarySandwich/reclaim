# 007 — Model engine · checklist

Living. Tick on completion, **append on discovery**. See `../../../AGENTS.md`.

## Build

- [x] `src/engines/types.ts` — `ModelEngine`, `Availability`, `ModelDescriptor`, `MachineSpecs`
- [x] `src/engines/prompt.ts` — system prompt, few-shot anchors, ladder, response parsing
- [x] `src/engines/gemini-nano.ts` — the engine
- [x] `src/engines/gemini-nano.test.ts` — 22 tests against a contract-faithful fake
- [x] `src/engines/registry.ts` — catalogue + spec-based recommendation
- [x] `src/engines/index.ts`
- [ ] `src/engines/webllm.ts` — deferred (ADR-022)
- [ ] Wire the engine into the service worker's `CLASSIFY_BATCH` handler

## Verification

- [x] `pnpm test` green — 239 passing
- [ ] Verified against a real Gemini Nano — **needs spike S2 / a human**

## Discovered while working

- [x] The `downloadprogress` event payload shape is **not pinned**. Chrome has reported `loaded`
      as both a 0-1 fraction and a byte count across versions, and whether `total` is populated is
      unverified. Normalised defensively, but the progress bar may be wrong until someone watches
      a real 4.27 GB download.
- [x] `LanguageModel` is declared locally as a minimal interface rather than imported from a types
      package, so it cannot silently drift from what we actually call.
- [x] Registry treats `maxBufferSize * 4` as a VRAM proxy. That is crude —  `maxBufferSize` bounds
      a single allocation, not total memory — and deliberately generous, because being wrong
      should mean offering a model that turns out slow, not refusing one that would have worked.

## Discovered — not done

- [ ] **Nothing calls this engine yet.** `CLASSIFY_BATCH` still returns an empty verdict list.
      Wiring it needs the scheduler (008), because firing unbounded `judge()` calls at a scrolling
      feed is exactly the behaviour the triage router exists to prevent.
- [ ] **Service workers die after ~30s idle and sessions do not survive.** `create()` cost on wake
      is unmeasured and is the one remaining argument for hosting in the offscreen document after
      all. Measure before finalising (brief risk A2).
- [ ] The few-shot anchors are four hand-written examples. They are doing most of the calibration
      work and have never been evaluated. They are the highest-leverage thing to improve once
      shadow-mode data exists.
- [ ] No `measureInputUsage` call, so we do not know how much of Nano's context window the system
      prompt plus anchors actually consume. If it is most of it, long posts will silently evict
      the anchors despite the per-post cloning.
- [ ] `parseResponse` accepts a response with only ONE of the two axes. Intentional — partial
      signal beats none — but it means an axis can silently go unscored for a whole session if the
      model consistently omits it. Worth logging in shadow mode.
- [ ] Prompt is English-only, and so are the few-shot anchors. LinkedIn is heavily non-English.
