// Shared probe. Loaded as classic script / importScripts'd everywhere.
globalThis.REPORT_URL = 'https://www.linkedin.test:8443/report';

globalThis.pmProbe = async function pmProbe(ctx, extra) {
  const g = globalThis;
  const r = {
    ctx: ctx,
    t: Date.now(),
    href: (typeof location !== 'undefined') ? location.href : '(no location)',
    origin: (typeof origin !== 'undefined') ? origin : ((typeof location !== 'undefined') ? location.origin : '?'),
    isSecureContext: g.isSecureContext,
    globalCtor: Object.prototype.toString.call(g),
    typeofLanguageModel: typeof g.LanguageModel,
    inSelf: (typeof self !== 'undefined') ? ('LanguageModel' in self) : null,
    inGlobalThis: 'LanguageModel' in g,
    // sibling built-in AI APIs, for contrast
    typeofSummarizer: typeof g.Summarizer,
    typeofTranslator: typeof g.Translator,
    typeofLanguageDetector: typeof g.LanguageDetector,
    typeofWriter: typeof g.Writer,
  };
  if (extra) Object.assign(r, extra);

  // Permissions-Policy introspection (documents only)
  try {
    if (typeof document !== 'undefined') {
      const fp = document.featurePolicy || document.permissionsPolicy;
      if (fp) {
        r.ppAllowsLanguageModel = fp.allowsFeature('language-model');
        r.ppAllowsSummarizer = fp.allowsFeature('summarizer');
        const feats = fp.features();
        r.ppHasLanguageModelToken = feats.includes('language-model');
        r.ppAiTokens = feats.filter(f => /language|summar|translat|writ|rewrit|proofread|prompt|model/i.test(f)).sort();
      } else {
        r.ppNote = 'no featurePolicy/permissionsPolicy object';
      }
    }
  } catch (e) { r.ppError = String(e); }

  if (r.typeofLanguageModel !== 'undefined') {
    try { r.availability = await g.LanguageModel.availability(); }
    catch (e) { r.availabilityError = e.name + ': ' + e.message; }
    try {
      const p = await g.LanguageModel.params();
      r.params = p && { defaultTopK: p.defaultTopK, maxTopK: p.maxTopK, defaultTemperature: p.defaultTemperature, maxTemperature: p.maxTemperature };
    } catch (e) { r.paramsError = e.name + ': ' + e.message; }

    if (r.availability === 'available') {
      try {
        const t0 = Date.now();
        const s = await g.LanguageModel.create({
          initialPrompts: [{ role: 'system', content: 'You are a terse classifier.' }],
        });
        r.createMs = Date.now() - t0;
        r.created = true;
        r.inputQuota = s.inputQuota;
        const t1 = Date.now();
        r.answer = await s.prompt('Answer with the single word: PONG');
        r.promptMs = Date.now() - t1;
        r.inputUsage = s.inputUsage;
        s.destroy();
      } catch (e) { r.createError = e.name + ': ' + e.message; }
    }
  }
  return r;
};

globalThis.pmReport = async function pmReport(obj) {
  try {
    await fetch(globalThis.REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(obj),
    });
  } catch (e) {
    try { console.error('[pmReport failed]', obj.ctx, String(e)); } catch (_) {}
  }
};
