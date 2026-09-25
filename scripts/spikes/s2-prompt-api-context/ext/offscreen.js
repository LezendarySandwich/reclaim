(async () => {
  const r = await pmProbe('OFFSCREEN_DOCUMENT', { extensionOrigin: location.origin });
  await pmReport(r);
})();
