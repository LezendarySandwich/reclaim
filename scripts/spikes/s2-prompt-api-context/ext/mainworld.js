// Runs in the PAGE's MAIN world at the page origin (https://www.linkedin.localtest.me).
(async () => {
  const r = {
    ctx: 'PAGE_MAIN_WORLD',
    href: location.href,
    origin: location.origin,
    isSecureContext: window.isSecureContext,
    typeofLanguageModel: typeof window.LanguageModel,
    typeofSummarizer: typeof window.Summarizer,
    isTopLevelFrame: window.top === window,
  };
  try {
    const fp = document.featurePolicy || document.permissionsPolicy;
    if (fp) {
      r.ppAllowsLanguageModel = fp.allowsFeature('language-model');
      r.ppHasLanguageModelToken = fp.features().includes('language-model');
      r.ppAiTokens = fp.features().filter(f => /language|summar|translat|writ|rewrit|proofread|prompt|model/i.test(f)).sort();
      r.ppAllFeaturesCount = fp.features().length;
    }
  } catch (e) { r.ppError = String(e); }
  if (r.typeofLanguageModel !== 'undefined') {
    try { r.availability = await window.LanguageModel.availability(); }
    catch (e) { r.availabilityError = e.name + ': ' + e.message; }
  }
  await fetch('https://www.linkedin.localtest.me:8443/report', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(r),
  }).catch(() => {});
})();
