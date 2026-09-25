(async () => {
  const r = {
    scope: self.constructor && self.constructor.name,
    typeofLanguageModel: typeof self.LanguageModel,
    hasLanguageModel: 'LanguageModel' in self,
    typeofSummarizer: typeof self.Summarizer,
    typeofWriter: typeof self.Writer,
    typeofTranslator: typeof self.Translator,
    typeofLanguageDetector: typeof self.LanguageDetector,
    ua: navigator.userAgent
  };
  try { r.availability = await self.LanguageModel.availability(); } catch (e) { r.availabilityErr = String(e); }
  try { r.params = JSON.stringify(await self.LanguageModel.params()); } catch (e) { r.paramsErr = String(e); }
  try {
    await fetch('http://127.0.0.1:8731/report?d=' + encodeURIComponent(JSON.stringify(r)));
  } catch (e) {}
})();
