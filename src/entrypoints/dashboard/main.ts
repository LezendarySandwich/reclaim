import { browser } from 'wxt/browser'
import './style.css'
import { GATE_COPY, gateState, mayReadPosts } from '../../core/consent'
import {
  grantConsent,
  hasConsent,
  loadSettings,
  revokeConsent,
  saveSettings,
} from '../../storage/settings'
import { purgeAll, putLabel } from '../../storage/db'
import { MODELS, recommendModel } from '../../engines/registry'
import {
  authorsPanel,
  axisPanel,
  historyPanel,
  loadPanelData,
  overviewPanel,
  routerPanel,
  settingsPanel,
  thresholdPanel,
  trendPanel,
} from './panels'
import type { MachineSpecs } from '../../engines/types'
import type { Request, Response } from '../../core/messages'
import type { EngineState } from '../../core/types'

/**
 * Dashboard and onboarding.
 *
 * Two jobs that can only happen on an extension page:
 *
 * 1. **Consent and the host permission.** `permissions.request()` consumes a transient user
 *    gesture, so it must be called synchronously inside a click handler (ADR-020).
 * 2. **Starting a model download.** The service worker could do it gesture-free, but a 4.27 GB
 *    download deserves an explicit click (ADR-018).
 *
 * Plain DOM rather than React — a framework earns nothing on a settings page and costs bundle
 * weight on an extension that has to justify its size.
 *
 * ## Why this polls
 *
 * The first version re-rendered once after `INSTALL_MODEL` resolved and never again, so a
 * multi-gigabyte download showed as a single page flash and then nothing. The worker owns the
 * download progress; this page has to ask for it. Polling only while something is actually
 * happening, and patching the progress bar in place rather than rebuilding the page, so focus
 * and scroll position survive.
 */

const LINKEDIN_ORIGIN = 'https://www.linkedin.com/*'
const POLL_MS = 700

const root = document.getElementById('root')!
let pollTimer: number | null = null

async function readSpecs(): Promise<MachineSpecs> {
  const nav = navigator as Navigator & { deviceMemory?: number; gpu?: unknown }
  let hasWebGPU = false
  let gpuDescription: string | null = null
  let maxBufferMB: number | null = null

  try {
    const gpu = nav.gpu as { requestAdapter?: () => Promise<unknown> } | undefined
    if (gpu?.requestAdapter) {
      const adapter = (await gpu.requestAdapter()) as
        | { info?: { vendor?: string; architecture?: string }; limits?: { maxBufferSize?: number } }
        | null
      if (adapter) {
        hasWebGPU = true
        gpuDescription =
          [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(' ') || null
        maxBufferMB = adapter.limits?.maxBufferSize
          ? Math.round(adapter.limits.maxBufferSize / (1024 * 1024))
          : null
      }
    }
  } catch {
    // WebGPU unavailable or blocked. Not an error — it means the WebLLM tier is out.
  }

  let storageQuotaMB: number | null = null
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (estimate?.quota) storageQuotaMB = Math.round(estimate.quota / (1024 * 1024))
  } catch {
    // Nice-to-have only.
  }

  return {
    deviceMemoryGB: nav.deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    hasWebGPU,
    gpuDescription,
    maxBufferMB,
    storageQuotaMB,
  }
}

async function send(request: Request): Promise<Response | undefined> {
  try {
    return (await browser.runtime.sendMessage(request)) as Response | undefined
  } catch {
    // The worker can be asleep or restarting. Not worth surfacing — the next poll retries.
    return undefined
  }
}

async function getEngineState(): Promise<EngineState> {
  const res = await send({ type: 'GET_ENGINE_STATE', target: 'background' })
  if (res?.ok && res.type === 'GET_ENGINE_STATE') return res.state
  return { status: 'uninitialized' }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  node.append(...children)
  return node
}

interface StatusView {
  dot: 'ok' | 'working' | 'off'
  text: string
}

function describeEngine(state: EngineState): StatusView {
  switch (state.status) {
    case 'ready':
      return { dot: 'ok', text: 'Active — posts are being checked on this device.' }
    case 'downloading':
      return { dot: 'working', text: 'Downloading the model…' }
    case 'needs_setup':
      return { dot: 'off', text: 'No model installed. Nothing is being hidden.' }
    case 'checking':
      return { dot: 'working', text: 'Checking what this device can run…' }
    case 'degraded':
      return {
        dot: 'off',
        text:
          state.reason === 'unsupported_hardware_or_policy'
            ? 'Your device or your organisation’s settings do not allow an on-device model. ' +
              'Nothing will be hidden. chrome://on-device-internals has the details.'
            : `Not working: ${state.detail ?? state.reason}. Nothing is being hidden.`,
      }
    default:
      return { dot: 'working', text: 'Starting up…' }
  }
}

/** Patch the progress bar in place. Rebuilding the page each tick would fight the user. */
function updateProgress(state: EngineState): void {
  const bar = document.getElementById('dl-bar')
  const fill = document.getElementById('dl-fill')
  const label = document.getElementById('dl-label')
  const status = document.getElementById('status-text')
  const dot = document.getElementById('status-dot')
  if (!bar || !fill || !label) return

  const view = describeEngine(state)
  if (status) status.textContent = view.text
  if (dot) dot.className = `dot ${view.dot}`

  if (state.status !== 'downloading') return

  // Chrome has reported `loaded` as a fraction in some versions and bytes in others, and `total`
  // is not always populated. A bar frozen at 0% looks broken; an indeterminate sweep is honest
  // about not knowing.
  const known = state.fraction > 0 && state.fraction <= 1
  bar.className = known ? 'bar' : 'bar indeterminate'
  fill.style.width = known ? `${Math.round(state.fraction * 100)}%` : ''
  label.textContent = known
    ? `${Math.round(state.fraction * 100)}% of about 4.3 GB`
    : 'Downloading about 4.3 GB. Chrome is not reporting progress for this download — ' +
      'chrome://on-device-internals shows the real status.'
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/** Poll only while something is in flight, and re-render fully only when the STATUS changes. */
function startPolling(from: EngineState): void {
  stopPolling()
  let last = from.status
  pollTimer = window.setInterval(() => {
    void (async () => {
      const state = await getEngineState()
      if (state.status !== last) {
        last = state.status
        stopPolling()
        await render()
        return
      }
      updateProgress(state)
      if (state.status !== 'downloading' && state.status !== 'checking') stopPolling()
    })()
  }, POLL_MS)
}

async function render(): Promise<void> {
  stopPolling()
  root.replaceChildren()

  const [consent, granted, engineState, specs] = await Promise.all([
    hasConsent(),
    browser.permissions.contains({ origins: [LINKEDIN_ORIGIN] }),
    getEngineState(),
    readSpecs(),
  ])

  const gate = gateState({ hasConsent: consent, hasHostPermission: granted })
  const copy = GATE_COPY[gate.status]

  root.append(
    el('h1', { textContent: 'Reclaim' }),
    el('p', {
      className: 'tagline',
      textContent: 'Hides AI-generated and engagement-bait posts. Everything runs on this device.',
    }),
  )

  // ---- Consent and access ------------------------------------------------------------------
  const access = el('section')
  access.append(el('h2', { textContent: copy.title }), el('p', { textContent: copy.detail }))

  if (!mayReadPosts(gate)) {
    // Disclosed up front rather than buried (ADR-021).
    access.append(
      el('p', {
        className: 'fineprint',
        textContent:
          'LinkedIn’s terms prohibit extensions that change how the site looks. Using Reclaim ' +
          'could in principle get your account restricted. We know of no case of this happening, ' +
          'and Reclaim makes no requests to LinkedIn’s servers — it only reads what your browser ' +
          'has already rendered.',
      }),
    )

    const allow = el('button', {
      className: 'primary',
      textContent: 'Allow Reclaim to read my feed',
    })
    allow.addEventListener('click', () => {
      // Synchronous inside the handler: permissions.request() consumes the transient user
      // activation, and awaiting anything first would lose it.
      void browser.permissions.request({ origins: [LINKEDIN_ORIGIN] }).then(async (ok) => {
        if (!ok) return
        await grantConsent(Date.now())
        await render()
      })
    })
    access.append(el('div', { className: 'actions' }, [allow]))
    root.append(access)
    return
  }

  root.append(access)

  // ---- Status + model ----------------------------------------------------------------------
  const view = describeEngine(engineState)
  const model = el('section')
  model.append(
    el('h2', { textContent: 'Model' }),
    el('div', { className: 'status' }, [
      el('span', { className: `dot ${view.dot}`, id: 'status-dot' }),
      el('span', { id: 'status-text', textContent: view.text }),
    ]),
  )

  if (engineState.status === 'downloading') {
    const fill = el('i', { id: 'dl-fill' })
    model.append(
      el('div', { className: 'progress' }, [
        el('div', { className: 'bar', id: 'dl-bar' }, [fill]),
        el('div', { className: 'progress-label', id: 'dl-label', textContent: 'Starting…' }),
      ]),
      el('p', {
        className: 'muted',
        textContent:
          'You can close this page — the download continues in the background. It only happens once.',
      }),
    )
    updateProgress(engineState)
  }

  if (engineState.status === 'needs_setup' || engineState.status === 'degraded') {
    const nanoAvailable = engineState.status === 'needs_setup'
    const rec = recommendModel(specs, nanoAvailable)
    model.append(el('p', { className: 'muted', textContent: rec.rationale }))

    for (const m of MODELS) {
      const blocked = rec.unsupported.find((u) => u.id === m.id)
      const row = el('div', { className: 'model' })
      const head = el('div', { className: 'model-head' }, [
        el('span', { className: 'model-name', textContent: m.name }),
      ])
      if (m.id === rec.recommended) head.append(el('span', { className: 'badge rec', textContent: 'Recommended' }))
      if (blocked) head.append(el('span', { className: 'badge', textContent: 'Unavailable' }))

      row.append(
        head,
        el('div', {
          className: 'specs',
          textContent: `${(m.downloadMB / 1024).toFixed(1)} GB download · needs ~${(m.vramMB / 1024).toFixed(1)} GB graphics memory`,
        }),
        el('div', { className: 'muted', textContent: blocked ? blocked.why : m.note }),
      )

      if (!blocked) {
        const install = el('button', {
          className: m.id === rec.recommended ? 'primary' : '',
          textContent: `Install ${m.name}`,
        })
        install.addEventListener('click', () => {
          install.disabled = true
          install.textContent = 'Starting…'
          void send({ type: 'INSTALL_MODEL', target: 'background', engineId: m.id }).then(() =>
            // Re-render immediately so the progress bar appears, then poll it.
            render(),
          )
        })
        row.append(el('div', { className: 'actions' }, [install]))
      }
      model.append(row)
    }
  }
  root.append(model)

  // ---- Your data ---------------------------------------------------------------------------
  const data = el('section')
  data.append(
    el('h2', { textContent: 'Your data' }),
    el('p', {
      className: 'muted',
      textContent:
        'Everything Reclaim stores stays on this device. There is no account and no server. ' +
        'Post excerpts are kept for 90 days so the dashboard can show you what was hidden.',
    }),
  )

  const purge = el('button', { textContent: 'Delete everything stored' })
  purge.addEventListener('click', () => {
    purge.disabled = true
    void purgeAll().then(() => {
      purge.textContent = 'Deleted'
    })
  })

  const revoke = el('button', { textContent: 'Turn off and revoke access' })
  revoke.addEventListener('click', () => {
    void (async () => {
      await revokeConsent()
      await browser.permissions.remove({ origins: [LINKEDIN_ORIGIN] })
      await render()
    })()
  })

  data.append(el('div', { className: 'actions' }, [purge, revoke]))

  // ---- Metrics -------------------------------------------------------------------------------
  // Rendered before the data section so the interesting part is above the destructive buttons.
  try {
    const [panelData, settings] = await Promise.all([loadPanelData(Date.now()), loadSettings()])
    root.append(
      overviewPanel(panelData),
      trendPanel(panelData),
      axisPanel(panelData, settings),
      thresholdPanel(panelData, settings),
      routerPanel(panelData, settings),
      historyPanel(panelData, (row) => {
        // Disagreement is recorded per axis. For ai_written this is an "annoyance" label and
        // must not feed threshold tuning — see ADR-019 and metrics.usableForTuning.
        for (const axis of row.triggeredBy) {
          void putLabel({
            postId: row.postId,
            axis,
            userSays: false,
            verdictAtTime: row.signals[axis]?.score ?? row.topScore,
            at: Date.now(),
          })
        }
      }),
      authorsPanel(panelData),
      settingsPanel(settings, {
        onChange: (next) => {
          void saveSettings(next).then(render)
        },
      }),
    )
  } catch (e) {
    root.append(
      el('section', {}, [
        el('h2', { textContent: 'Metrics unavailable' }),
        el('p', {
          className: 'muted',
          textContent: `Could not read local history: ${e instanceof Error ? e.message : String(e)}`,
        }),
      ]),
    )
  }

  root.append(data)

  if (engineState.status === 'downloading' || engineState.status === 'checking') {
    startPolling(engineState)
  }

  // TODO(010): history timeline, accuracy from feedback labels, creator leaderboard. Blocked only
  // on persistence being wired — see docs/features/008-scheduler/checklist.md.
}

void render()
window.addEventListener('pagehide', stopPolling)
