(async () => {
  const r = await pmProbe('EXTENSION_PAGE_TAB', { extensionOrigin: location.origin });
  await pmReport(r);
  document.getElementById('out').textContent = JSON.stringify(r, null, 2);

  // Dedicated Worker spawned from an extension page -> tests AIPromptAPIForWorkers gate.
  try {
    const w = new Worker('worker.js');
    w.onmessage = (ev) => pmReport(ev.data);
    w.onerror = (e) => pmReport({ ctx: 'DEDICATED_WORKER', workerError: String(e.message || e) });
  } catch (e) {
    await pmReport({ ctx: 'DEDICATED_WORKER', spawnError: String(e) });
  }
})();
