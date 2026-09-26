/**
 * LinkedIn feed DOM audit — paste into DevTools console on a LOGGED-IN
 * https://www.linkedin.com/feed/ tab, scrolled to the top.
 *
 * Returns a promise. Run:  await linkedinDomAudit()
 * Takes ~20s (it scrolls the feed to test node recycling).
 *
 * Reports:
 *   1. which feed variant is live (modern/SDUI vs legacy/Ember)
 *   2. top data-* / componentkey attribute frequencies inside the feed
 *   3. match counts + "looks like a post root" counts for every candidate selector
 *   4. post-identity attribute coverage (how many posts expose a stable urn)
 *   5. field selector coverage (author, body, see-more, media, promoted)
 *   6. node recycling: does LinkedIn reuse the same DOM node for a different post?
 */
async function linkedinDomAudit() {
  const OUT = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel, root = document) => {
    try {
      return [...root.querySelectorAll(sel)];
    } catch {
      return null; // invalid selector in this browser
    }
  };
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const hash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  };

  // ───────────────────── 1. Feed variant ─────────────────────
  OUT.variant = {
    modern_body_data_rehydrated: !!document.querySelector('body[data-rehydrated]'),
    legacy_body_ember_application: !!document.querySelector('body.ember-application'),
    has_mainFeed_testid: !!document.querySelector('[data-testid="mainFeed"]'),
    has_scaffold_finite_scroll: !!document.querySelector('[class*="scaffold-finite-scroll"]'),
    has_feed_shared_update_v2: !!document.querySelector('.feed-shared-update-v2'),
    has_occludable_update: !!document.querySelector('.occludable-update'),
    has_componentkey_anywhere: !!document.querySelector('[componentkey]'),
    has_lazy_mount: !!document.querySelector('[data-lazy-mount-id]'),
  };

  // ───────────────────── 2. Feed root ─────────────────────
  const FEED_ROOT_CANDIDATES = [
    '[data-testid="mainFeed"]',
    'main .scaffold-finite-scroll__content',
    'main [data-finite-scroll-hotkey-context]',
    'main [role="list"]',
    'main[role="main"]',
    'main',
  ];
  OUT.feedRoot = FEED_ROOT_CANDIDATES.map((s) => ({ selector: s, count: (q(s) || []).length }));
  const feedRoot =
    FEED_ROOT_CANDIDATES.map((s) => document.querySelector(s)).find(Boolean) || document.body;
  OUT.feedRootUsed =
    feedRoot === document.body
      ? 'document.body (NO feed root matched — investigate)'
      : FEED_ROOT_CANDIDATES.find((s) => document.querySelector(s));

  // ───────────────────── 3. Attribute frequency inside the feed ─────────────────────
  const attrFreq = new Map();
  const attrSample = new Map();
  const attrValues = new Map();
  for (const el of feedRoot.querySelectorAll('*')) {
    for (const a of el.attributes) {
      if (!a.name.startsWith('data-') && a.name !== 'componentkey') continue;
      attrFreq.set(a.name, (attrFreq.get(a.name) || 0) + 1);
      if (!attrSample.has(a.name)) attrSample.set(a.name, a.value.slice(0, 140));
      if (!attrValues.has(a.name)) attrValues.set(a.name, new Set());
      const set = attrValues.get(a.name);
      if (set.size < 6) set.add(a.value.slice(0, 90));
    }
  }
  OUT.attrFrequency = [...attrFreq.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 45)
    .map(([name, count]) => ({
      name,
      count,
      distinctSample: [...(attrValues.get(name) || [])],
    }));

  // ───────────────────── 4. Candidate post-container selectors ─────────────────────
  // Heuristic for "is this actually one visible post?" — used to grade each selector.
  const looksLikePost = (el) => {
    if (!el || !el.isConnected) return false;
    const h = el.getBoundingClientRect().height;
    if (h < 60) return false;
    const hasActor = !!el.querySelector('a[href*="/in/"], a[href*="/company/"], a[href*="/school/"]');
    const hasBody = norm(el.textContent).length > 60;
    return hasActor && hasBody;
  };
  const dropNested = (els) => els.filter((e) => !els.some((o) => o !== e && o.contains(e)));

  const POST_SELECTORS = [
    // modern / SDUI (React) — evidence: real captured fixtures in
    // Hogwai/LinkedinSponsorBlock tests/fixtures/*.html (repo HEAD 2026-09-21)
    'div[componentkey="post-inner-key"]',
    'div[componentkey^="expandedFeedType_"][role="listitem"]',
    'div[componentkey^="expandedFeedType_"]',
    '[data-testid="mainFeed"] > div[data-display-contents="true"]',
    '[data-testid="mainFeed"] > div[role="listitem"]',
    'div[data-lazy-mount-id]',
    'div[data-display-contents="true"]',
    '[componentkey*="MAIN_FEED_RELEVANCE"] > [data-display-contents]',
    '[componentkey*="MAIN_FEED_RECENT"] > [data-display-contents]',
    'div[componentkey*="FeedType_MAIN_FEED"]',
    'div[componentkey*="FeedType_"]',
    'article[data-id="main-feed-card"]',
    'div[data-view-tracking-scope*=\'transporterKeys":["default"]\']',
    'div[data-view-tracking-scope*=\'transporterKeys":["sponsored"]\']',
    '[data-view-tracking-scope*="FEED_UPDATE_SERVED"]',
    '[data-view-name="feed-full-update"]',
    'main [role="list"] > [role="listitem"]',
    '[role="listitem"]',
    // legacy / Ember
    'div.feed-shared-update-v2',
    'div.feed-shared-update-v2[data-urn]',
    'div.occludable-update',
    '.scaffold-finite-scroll__content > div',
    'div[data-id^="urn:li:activity:"]',
    'div[data-urn^="urn:li:activity:"]',
    'div[data-id^="urn:li:aggregatedShare"]',
    'li.feed-item',
    'article[data-is-sponsored]',
  ];
  OUT.postSelectors = POST_SELECTORS.map((sel) => {
    const all = q(sel, feedRoot);
    if (all === null) return { selector: sel, error: 'INVALID SELECTOR' };
    const outer = dropNested(all);
    return {
      selector: sel,
      raw: all.length,
      afterDropNested: outer.length,
      looksLikePost: outer.filter(looksLikePost).length,
    };
  }).sort((a, b) => (b.looksLikePost || 0) - (a.looksLikePost || 0));

  // Pick the best-scoring selector as the working post root for later sections.
  const best = OUT.postSelectors.find((r) => r.looksLikePost > 0);
  OUT.bestPostSelector = best ? best.selector : null;
  const posts = best ? dropNested(q(best.selector, feedRoot)).filter(looksLikePost) : [];
  OUT.postCount = posts.length;
  if (!posts.length) {
    console.warn('[audit] No post containers matched. Everything below will be empty.');
    console.log(OUT);
    return OUT;
  }

  // ───────────────────── 5. Post identity coverage ─────────────────────
  const ID_ATTRS = [
    'data-urn',
    'data-id',
    'data-activity-urn',
    'data-chameleon-result-urn',
    'data-update-id',
    'data-occludable-job-id',
    'componentkey',
    'data-lazy-mount-id',
    'data-view-tracking-scope',
    'id',
  ];
  const idCoverage = {};
  for (const a of ID_ATTRS) idCoverage[a] = { onRoot: 0, onDescendant: 0, sample: null };
  let urnFromAnyAttr = 0;
  let urnFromHref = 0;
  const identities = [];

  for (const p of posts) {
    let urn = null;
    for (const a of ID_ATTRS) {
      const v = p.getAttribute(a);
      if (v) {
        idCoverage[a].onRoot++;
        if (!idCoverage[a].sample) idCoverage[a].sample = v.slice(0, 120);
      } else if (p.querySelector(`[${a}]`)) {
        idCoverage[a].onDescendant++;
        if (!idCoverage[a].sample) {
          idCoverage[a].sample = p.querySelector(`[${a}]`).getAttribute(a).slice(0, 120);
        }
      }
      const m = (v || '').match(/urn:li:(activity|ugcPost|share):\d+/i);
      if (m && !urn) urn = m[0];
    }
    if (urn) urnFromAnyAttr++;
    if (!urn) {
      // descendant scan
      for (const n of p.querySelectorAll('[data-urn],[data-id],[data-chameleon-result-urn],[componentkey]')) {
        for (const a of ['data-urn', 'data-id', 'data-chameleon-result-urn', 'componentkey']) {
          const m = (n.getAttribute(a) || '').match(/urn:li:(activity|ugcPost|share):\d+/i);
          if (m) { urn = m[0]; break; }
        }
        if (urn) break;
      }
      if (urn) urnFromAnyAttr++;
    }
    if (!urn) {
      const a = p.querySelector('a[href*="/feed/update/"]');
      const m = a && decodeURIComponent(a.getAttribute('href')).match(/urn:li:(activity|ugcPost|share):\d+/i);
      if (m) { urn = m[0]; urnFromHref++; }
    }
    identities.push({ el: p, urn, textHash: hash(norm(p.textContent).slice(0, 400)) });
  }
  OUT.identity = {
    posts: posts.length,
    withUrnFromAttribute: urnFromAnyAttr,
    withUrnOnlyFromUpdateHref: urnFromHref,
    withNoStableUrn: identities.filter((i) => !i.urn).length,
    perAttribute: idCoverage,
    sampleUrns: identities.filter((i) => i.urn).slice(0, 5).map((i) => i.urn),
  };

  // ───────────────────── 6. Field selector coverage ─────────────────────
  const FIELDS = {
    authorName: [
      'a[componentkey="author-name-key"]',
      '[componentkey="name-key"]',
      '[componentkey="company-name-key"]',
      '[data-view-name*="feed-actor"] a[href*="/in/"] span[aria-hidden="true"]',
      'a[data-view-name*="actor"][href] span[aria-hidden="true"]',
      '.update-components-actor__title span[aria-hidden="true"]',
      '.update-components-actor__name',
      'a[href*="/in/"] span[aria-hidden="true"]',
      'a[href*="/in/"]',
    ],
    authorProfileUrl: [
      'a[componentkey="author-name-key"][href]',
      'a[componentkey="author-avatar-key"][href]',
      'a[componentkey="company-logo-key"][href]',
      'a[data-view-name*="feed-actor"][href]',
      'a[data-view-name="feed-header-actor-image"][href]',
      '.update-components-actor__meta-link[href]',
      'a[href*="/in/"]',
      'a[href*="/company/"]',
    ],
    bodyText: [
      'p[componentkey="body-key"]',
      'p[componentkey^="feed-commentary"]',
      '[data-testid="expandable-text-box"]',
      '[data-view-name="feed-commentary"]',
      '[data-view-name*="commentary"]',
      'p[componentkey^="feed-commentary"]',
      '.update-components-text',
      '.feed-shared-update-v2__commentary',
      '.feed-shared-inline-show-more-text',
      '.update-components-text-view',
      '.break-words span[dir="ltr"]',
    ],
    seeMore: [
      'button[aria-label*="see more" i]',
      'button[aria-label*="more" i]',
      '.feed-shared-inline-show-more-text__see-more-less-toggle',
      '.see-more',
      '[data-testid="expandable-text-box"] button',
    ],
    media: [
      '[data-view-name*="image"] img',
      '[data-view-name*="document"]',
      '[data-testid*="carousel"]',
      '[aria-roledescription="carousel"]',
      'video',
      '.update-components-image img',
      '.update-components-linkedin-video',
      '.update-components-article',
      'img',
    ],
    promoted: [
      '[componentkey="sponsored-indicator-key"]',
      '[data-sponsored-tracking-url]',
      'article[data-sponsored-tracking-url]',
      '[data-is-sponsored="true"]',
      '[componentkey*="urn:li:sponsoredContentV2"]',
      '[data-view-tracking-scope*="SPONSORED"]',
      '[data-view-tracking-scope*=\'transporterKeys":["sponsored"]\']',
      '.update-components-actor__sub-description',
      '[aria-label*="Promoted" i]',
    ],
    timestamp: ['time[datetime]', 'time', '.update-components-actor__sub-description'],
    controlMenu: [
      '[data-view-name="feed-control-menu"]',
      'button[aria-label*="control menu" i]',
      'button[aria-label*="more options" i]',
    ],
  };
  OUT.fields = {};
  for (const [field, sels] of Object.entries(FIELDS)) {
    OUT.fields[field] = sels.map((sel) => {
      let hit = 0;
      let sample = null;
      for (const p of posts) {
        const n = (() => { try { return p.querySelector(sel); } catch { return undefined; } })();
        if (n === undefined) return { selector: sel, error: 'INVALID SELECTOR' };
        if (n) {
          hit++;
          if (!sample) {
            sample = field === 'authorProfileUrl'
              ? n.getAttribute('href')
              : norm(n.textContent).slice(0, 80) || `<${n.tagName.toLowerCase()}>`;
          }
        }
      }
      return { selector: sel, hitPosts: hit, ofPosts: posts.length, pct: Math.round((hit / posts.length) * 100), sample };
    }).sort((a, b) => (b.hitPosts || 0) - (a.hitPosts || 0));
  }

  // Text-based promoted label (what every filter list actually relies on)
  OUT.promotedByText = posts.filter((p) =>
    /(^|\s)(promoted|sponsored)(\s|$)/i.test(norm(p.textContent).slice(0, 300))
  ).length;

  // ───────────────────── 7. DOM recycling / virtualization ─────────────────────
  // Stamp each post, scroll away and back, then see whether the SAME node now
  // holds a DIFFERENT post (recycled) or was detached (unmounted).
  const STAMP = 'data-dom-audit-id';
  identities.forEach((rec, i) => {
    rec.stamp = String(i);
    rec.el.setAttribute(STAMP, rec.stamp);
  });
  // FIX (2026-09-26): the first run of this script scrolled `window` and reported
  // scrollHeight 780 before AND after, i.e. the page never moved and the recycling verdict was
  // meaningless. LinkedIn's modern build scrolls an inner container, not the document, so find
  // the real scroller by walking up from the feed root looking for an actually-overflowing
  // ancestor. Falls back to the window for the legacy feed.
  const findScroller = (start) => {
    let node = start;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const scrolls = /auto|scroll|overlay/.test(style.overflowY);
      if (scrolls && node.scrollHeight > node.clientHeight + 50) return node;
      node = node.parentElement;
    }
    const doc = document.scrollingElement || document.documentElement;
    return doc.scrollHeight > window.innerHeight + 50 ? doc : null;
  };

  const scroller = findScroller(identities[0]?.el ?? feedRoot) ||
    document.scrollingElement || document.documentElement;
  const usingWindow = scroller === document.scrollingElement || scroller === document.documentElement;

  const readTop = () => (usingWindow ? window.scrollY : scroller.scrollTop);
  const readHeight = () => scroller.scrollHeight;
  const scrollDown = (px) => {
    if (usingWindow) window.scrollBy(0, px);
    else scroller.scrollTop += px;
  };

  const startY = readTop();
  const heightBefore = readHeight();

  for (let i = 0; i < 6; i++) {
    scrollDown(window.innerHeight * 1.5);
    await sleep(700);
  }
  const heightAfterScroll = readHeight();
  const topAfterScroll = readTop();

  if (usingWindow) window.scrollTo(0, startY);
  else scroller.scrollTop = startY;
  await sleep(1500);

  let stillConnectedSameContent = 0;
  let recycledSameNodeNewContent = 0;
  let detached = 0;
  const recycleExamples = [];
  for (const rec of identities) {
    if (!rec.el.isConnected) { detached++; continue; }
    const nowHash = hash(norm(rec.el.textContent).slice(0, 400));
    if (nowHash === rec.textHash) {
      stillConnectedSameContent++;
    } else {
      recycledSameNodeNewContent++;
      if (recycleExamples.length < 3) {
        recycleExamples.push({
          stamp: rec.stamp,
          wasUrn: rec.urn,
          nowText: norm(rec.el.textContent).slice(0, 90),
        });
      }
    }
  }
  // Did our stamps survive on nodes we never stamped? (would mean cloned subtrees)
  const stampedNow = q(`[${STAMP}]`).length;

  OUT.recycling = {
    stampedPosts: identities.length,
    detachedAfterScroll: detached,
    stillConnectedSameContent,
    recycledSameNodeNewContent,
    stampsPresentAfterScroll: stampedNow,
    scrollHeightBefore: heightBefore,
    scrollHeightAfterScroll: heightAfterScroll,
    // Guard against the failure the first run hit silently: if nothing moved, the verdict below
    // is meaningless and must not be believed.
    scrollerDescription: usingWindow
      ? 'window/document'
      : `${scroller.tagName.toLowerCase()}${scroller.getAttribute('data-testid') ? '[data-testid=' + scroller.getAttribute('data-testid') + ']' : ''}`,
    scrolledBy: topAfterScroll - startY,
    scrollActuallyHappened: topAfterScroll - startY > 100 || heightAfterScroll > heightBefore,
    verdict:
      // Refuse to claim STABLE when the page never moved. The first run of this script reported
      // STABLE with scrollHeight identical before and after, which read as a real answer and was
      // not one — it had scrolled the window while LinkedIn scrolls an inner container.
      !(topAfterScroll - startY > 100 || heightAfterScroll > heightBefore)
        ? 'INCONCLUSIVE: the feed never actually scrolled, so nothing was tested. Check scrollerDescription.'
        : recycledSameNodeNewContent > 0
          ? 'RECYCLING: same DOM node reused for different content — you MUST key state by post id, not by node'
          : detached > identities.length * 0.3
            ? 'UNMOUNTING: nodes are destroyed/recreated (virtualized) — WeakMap on node is unsafe across scroll'
            : 'STABLE: nodes persisted with their content across this scroll',
    recycleExamples,
  };

  // cleanup stamps
  for (const el of q(`[${STAMP}]`) || []) el.removeAttribute(STAMP);

  console.log('%c=== LinkedIn DOM audit ===', 'font-weight:bold;font-size:14px');
  console.log('variant', OUT.variant);
  console.table(OUT.attrFrequency);
  console.table(OUT.postSelectors);
  console.log('best post selector:', OUT.bestPostSelector, '| posts:', OUT.postCount);
  console.log('identity', OUT.identity);
  for (const [f, rows] of Object.entries(OUT.fields)) {
    console.log('%cfield: ' + f, 'font-weight:bold');
    console.table(rows);
  }
  console.log('promoted-by-text count:', OUT.promotedByText);
  console.log('%crecycling', 'font-weight:bold', OUT.recycling);
  window.__liAudit = OUT;
  console.log('Full object also at window.__liAudit — copy(window.__liAudit) to clipboard.');
  return OUT;
}
