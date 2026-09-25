(async () => {
  const isTop = (window.top === window);
  const res = await pmProbe('CONTENT_SCRIPT_ISOLATED', {
    isTopLevelFrame: isTop,
    frameLabel: isTop ? 'top' : (document.documentElement.dataset.frameLabel || 'iframe'),
    pageUrl: location.href,
    extensionId: chrome.runtime.id,
    extensionOriginSeenFromCS: chrome.runtime.getURL('').replace(/\/$/, ''),
  });
  await pmReport(res);

  // Inject the MAIN world probe (page origin, page's JS realm) for contrast.
  if (isTop) {
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('mainworld.js');
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      await pmReport({ ctx: 'CS_NOTE', mainWorldInjectErr: String(e) });
    }
  }
})();
