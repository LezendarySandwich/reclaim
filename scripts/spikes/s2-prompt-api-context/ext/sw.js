importScripts('probe.js');

// MV3 service workers restart on every event. The original version called run() at top level AND
// on onInstalled, and run() calls chrome.tabs.create() — so every single SW wake-up spawned
// another extension tab, and every wake-up re-POSTed to a report server that is only running
// while RUN-ME.sh is running. That is a tab-spawning, request-failing loop.
//
// Guard on session storage so the probe runs exactly once per browser session.
async function runOnce() {
  const KEY = 'pmprobe_ran';
  try {
    const got = await chrome.storage.session.get(KEY);
    if (got && got[KEY]) return;
    await chrome.storage.session.set({ [KEY]: true });
  } catch (e) {
    // storage.session unavailable — fall through rather than looping forever.
  }
  await run();
}

async function run() {
  // 1) The MV3 background service worker itself.
  const swRes = await pmProbe('SERVICE_WORKER', {
    swScope: (self.registration && self.registration.scope) || null,
    swGlobalIsServiceWorkerGlobalScope:
      typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope,
    extensionOrigin: location.origin,
  });
  await pmReport(swRes);

  // 2) Offscreen document — the question this whole spike exists to answer.
  try {
    if (chrome.offscreen) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!contexts.length) {
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

  // 3) A top-level extension page.
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('extpage.html'), active: false });
  } catch (e) {
    await pmReport({ ctx: 'SW_NOTE', extPageErr: e.name + ': ' + e.message });
  }
}

chrome.runtime.onInstalled.addListener(runOnce);
chrome.runtime.onStartup.addListener(runOnce);
runOnce();
