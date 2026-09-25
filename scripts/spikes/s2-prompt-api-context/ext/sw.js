importScripts('probe.js');

async function run() {
  // 1) Probe the MV3 background service worker itself.
  const swRes = await pmProbe('SERVICE_WORKER', {
    swScope: (self.registration && self.registration.scope) || null,
    swGlobalIsServiceWorkerGlobalScope:
      typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope,
    extensionOrigin: location.origin,
  });
  await pmReport(swRes);

  // 2) Offscreen document.
  try {
    if (chrome.offscreen) {
      const has = await chrome.offscreen.hasDocument?.();
      if (!has) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['WORKERS'],
          justification: 'probe LanguageModel availability in an offscreen document',
        });
      }
      await pmReport({ ctx: 'SW_NOTE', offscreenCreated: true });
    } else {
      await pmReport({ ctx: 'SW_NOTE', offscreenCreated: false, err: 'chrome.offscreen undefined' });
    }
  } catch (e) {
    await pmReport({ ctx: 'SW_NOTE', offscreenCreated: false, err: e.name + ': ' + e.message });
  }

  // 3) Extension page in a tab (options/popup-equivalent top-level extension page).
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('extpage.html'), active: false });
  } catch (e) {
    await pmReport({ ctx: 'SW_NOTE', extPageErr: e.name + ': ' + e.message });
  }
}

run();
chrome.runtime.onInstalled.addListener(run);
