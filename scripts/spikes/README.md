# Spikes

Empirical probes that settle questions the research could not. Each blocks something specific —
see `docs/architecture/technical-brief.md` §10 for the full risk register.

Both of the spikes here **need a human**. Chrome cannot be launched from an agent session
(`bootstrap_check_in … Permission denied (1100)`), and LinkedIn's feed needs a real logged-in
session.

## S2 — Where can the Prompt API and WebGPU actually run?

**Blocks:** the entire model layer. ADR-009 picks the offscreen document by eliminating every
alternative, but nobody has confirmed `LanguageModel` and `navigator.gpu` work *inside* one.

```
./scripts/spikes/s2-prompt-api-context/RUN-ME.sh
```

Launches a throwaway Chrome against a fake HTTPS origin served two ways — with and without
`Permissions-Policy: language-model=()` — loads an unpacked probe extension, and reports
`typeof LanguageModel`, `availability()`, `isSecureContext` and `navigator.gpu.requestAdapter()`
from every context: service worker, offscreen document, extension page, dedicated worker,
content-script isolated world, page main world, and both iframes. Takes ~60s.

**Read the results for three things:**
1. Does the offscreen row show `LM=object` *and* a working GPU adapter? If not, the model host moves.
2. Does `adapter.info` name a real GPU, or SwiftShader? Software rendering is not viable.
3. Does the content-script row differ between `/feed` and `/feed-blocked`? That tells us whether an
   isolated world inherits the host page's Permissions-Policy — i.e. whether LinkedIn holds a
   one-header kill switch over content-script inference.

It symlinks your real `OptGuideOnDeviceModel` directory into the throwaway profile so it can see an
already-downloaded Nano without re-downloading 4.27 GB.

**You will have to load the extension by hand.** Chrome silently ignores `--load-extension` now
(verified on 153.0.8010.53: the throwaway profile registered zero extensions and logged no error).
The script detects this, prints the three clicks needed — `chrome://extensions` → Developer mode →
Load unpacked → `ext/` — and keeps watching `results.jsonl` while you do it.

**Already answered by this spike (2026-09-25):** `language-model` is a real Permissions-Policy
token, and a host page controls it. `/feed` reported `allowsFeature('language-model') === true`;
`/feed-blocked`, served with `Permissions-Policy: language-model=()`, reported `false` — and
`availability()` flipped from `downloadable` to `unavailable` with it. A site can switch the Prompt
API off for its own pages with one response header. Also confirmed on this machine: Nano is
`downloadable`, i.e. not yet installed but the hardware qualifies.

**Still open:** every extension context. That is the part that decides ADR-009.

**If it fails:** the script preflights Chrome's path, DNS resolution, and the port, and warns if
Chrome is already running — a running instance can swallow the URLs into itself and drop every
command-line flag, so quit Chrome first if the probe reports nothing.

Known trap, already handled: this machine proxies HTTP through `localhost:10054`, and `NO_PROXY`
covers only `127.0.0.1`/`localhost`/`::1`. A proxy makes `--host-resolver-rules` a no-op, because
the proxy resolves names itself — which is what produced `DNS_PROBE_STARTED` on the first attempt.
Fixed two ways: the harness uses `*.localtest.me` (public DNS → 127.0.0.1) and passes
`--no-proxy-server`.

## S4 — LinkedIn feed DOM

**Blocks:** the adapter, and therefore everything visible.

Open a logged-in `https://www.linkedin.com/feed/`, scroll to the top, open DevTools, paste
`linkedin-dom-audit.js`, then:

```js
await linkedinDomAudit()
```

Takes ~20s — it scrolls the feed to test whether LinkedIn recycles DOM nodes between posts, which
determines whether "already scored" can be tracked on the element at all.

Reports: which feed variant is live, `data-*` attribute frequencies, match counts for every
candidate post selector, post-identity coverage, field selector coverage, and the recycling verdict.

Save the JSON output to `docs/features/*/s4-results.json` — it is the evidence behind every
selector we choose, and the thing to diff against when LinkedIn breaks us.
