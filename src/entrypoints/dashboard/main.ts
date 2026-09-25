/**
 * Dashboard — history, metrics, creator leaderboard, model manager, settings.
 *
 * This page is also the ONLY place a model download may start. The Prompt API rejects `create()`
 * without a transient user gesture when the model is not already present, and neither a service
 * worker nor an offscreen document can ever supply one.
 */
const root = document.getElementById('root')
if (root) root.textContent = 'Reclaim — dashboard not yet implemented'

export {}
