importScripts('probe.js');
(async () => {
  const r = await pmProbe('DEDICATED_WORKER', {
    isWorkerGlobalScope: typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope,
    isDedicated: typeof DedicatedWorkerGlobalScope !== 'undefined' && self instanceof DedicatedWorkerGlobalScope,
  });
  postMessage(r);
})();
