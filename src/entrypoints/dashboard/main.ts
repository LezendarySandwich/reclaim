import { browser } from 'wxt/browser'
import { GATE_COPY, gateState, mayReadPosts } from '../../core/consent'
import { grantConsent, hasConsent, revokeConsent } from '../../storage/settings'
import { purgeAll } from '../../storage/db'
import { MODELS, recommendModel } from '../../engines/registry'
import type { MachineSpecs } from '../../engines/types'
import type { Request, Response } from '../../core/messages'
import type { EngineState } from '../../core/types'

/**
 * Dashboard and onboarding.
 *
 * This page carries two jobs that can only happen here:
 *
 * 1. **Consent and the host permission.** `permissions.request()` requires a transient user
 *    gesture, so it must originate from a real click on an extension page (ADR-020).
 * 2. **Starting a model download.** The service worker *could* do it gesture-free, but a
 *    multi-gigabyte download deserves an explicit click (ADR-018).
 *
 * Plain DOM rather than React: this is a settings page, and a framework would earn nothing here
 * while adding a dependency and bundle weight to an extension that has to justify its size.
 */

const LINKEDIN_ORIGIN = 'https://www.linkedin.com/*'

const root = document.getElementById('root')!

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
        gpuDescription = [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(' ') || null
        maxBufferMB = adapter.limits?.maxBufferSize
          ? Math.round(adapter.limits.maxBufferSize / (1024 * 1024))
          : null
      }
    }
  } catch {
    // WebGPU unavailable or blocked. Not an error — it just means the WebLLM tier is out.
  }

  let storageQuotaMB: number | null = null
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (estimate?.quota) storageQuotaMB = Math.round(estimate.quota / (1024 * 1024))
  } catch {
    // Storage estimate is a nice-to-have.
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
  return (await browser.runtime.sendMessage(request)) as Response | undefined
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

function describeEngine(state: EngineState): string {
  switch (state.status) {
    case 'ready':
      return 'Ready. Posts are being checked on this device.'
    case 'downloading':
      return `Downloading the model — ${Math.round(state.fraction * 100)}%.`
    case 'needs_setup':
      return 'No model installed yet. Nothing is being hidden.'
    case 'checking':
      return 'Checking what this device can run…'
    case 'degraded':
      return state.reason === 'unsupported_hardware_or_policy'
        ? 'Your device or your organisation’s settings do not allow an on-device model. ' +
            'Nothing will be hidden. You can check chrome://on-device-internals for details.'
        : `Not working: ${state.reason}. Nothing is being hidden.`
    default:
      return 'Starting up…'
  }
}

async function render(): Promise<void> {
  root.replaceChildren()

  const [consent, granted, engineState, specs] = await Promise.all([
    hasConsent(),
    browser.permissions.contains({ origins: [LINKEDIN_ORIGIN] }),
    getEngineState(),
    readSpecs(),
  ])

  const gate = gateState({ hasConsent: consent, hasHostPermission: granted })
  const copy = GATE_COPY[gate.status]

  root.append(el('h1', { textContent: 'Reclaim' }))

  // ---- Consent and access ------------------------------------------------------------------
  const section = el('section')
  section.append(el('h2', { textContent: copy.title }), el('p', { textContent: copy.detail }))

  if (gate.status === 'needs_consent' || gate.status === 'needs_permission') {
    // Honesty about LinkedIn's terms, up front rather than buried (ADR-021).
    section.append(
      el('p', {
        textContent:
          'One more thing worth knowing: LinkedIn’s terms prohibit extensions that change how ' +
          'the site looks. Using Reclaim could in principle get your account restricted. We know ' +
          'of no case of this happening, and Reclaim makes no requests to LinkedIn’s servers — ' +
          'it only reads what your browser has already rendered.',
      }),
    )

    const button = el('button', { textContent: 'Allow Reclaim to read my feed' })
    button.addEventListener('click', () => {
      // MUST be inside the click handler, synchronously. permissions.request() consumes the
      // transient user activation, and awaiting anything first would lose it.
      void browser.permissions.request({ origins: [LINKEDIN_ORIGIN] }).then(async (ok) => {
        if (!ok) return
        await grantConsent(Date.now())
        await render()
      })
    })
    section.append(button)
  }
  root.append(section)

  if (!mayReadPosts(gate)) return

  // ---- Model -------------------------------------------------------------------------------
  const modelSection = el('section')
  modelSection.append(
    el('h2', { textContent: 'Model' }),
    el('p', { textContent: describeEngine(engineState) }),
  )

  if (engineState.status === 'needs_setup' || engineState.status === 'degraded') {
    const nanoAvailable = engineState.status === 'needs_setup'
    const rec = recommendModel(specs, nanoAvailable)
    modelSection.append(el('p', { textContent: rec.rationale }))

    for (const model of MODELS) {
      const blocked = rec.unsupported.find((u) => u.id === model.id)
      const row = el('div')
      row.append(
        el('strong', { textContent: model.name }),
        el('span', {
          textContent: ` — ${model.downloadMB} MB download, needs about ${model.vramMB} MB of graphics memory`,
        }),
        el('p', { textContent: model.note }),
      )
      if (blocked) {
        row.append(el('p', { textContent: `Unavailable: ${blocked.why}` }))
      } else {
        const install = el('button', {
          textContent:
            model.id === rec.recommended ? `Install ${model.name} (recommended)` : `Install ${model.name}`,
        })
        install.addEventListener('click', () => {
          install.disabled = true
          install.textContent = 'Installing…'
          void send({ type: 'INSTALL_MODEL', target: 'background', engineId: model.id }).then(render)
        })
        row.append(install)
      }
      modelSection.append(row)
    }
  }
  root.append(modelSection)

  // ---- Your data ---------------------------------------------------------------------------
  const data = el('section')
  data.append(
    el('h2', { textContent: 'Your data' }),
    el('p', {
      textContent:
        'Everything Reclaim stores stays on this device. There is no account and no server. ' +
        'Post excerpts are kept for 90 days so the dashboard can show you what was hidden.',
    }),
  )

  const purge = el('button', { textContent: 'Delete everything Reclaim has stored' })
  purge.addEventListener('click', () => {
    void purgeAll().then(() => {
      purge.textContent = 'Deleted.'
    })
  })

  const revoke = el('button', { textContent: 'Turn Reclaim off and revoke access' })
  revoke.addEventListener('click', () => {
    void (async () => {
      await revokeConsent()
      await browser.permissions.remove({ origins: [LINKEDIN_ORIGIN] })
      await render()
    })()
  })

  data.append(purge, revoke)
  root.append(data)

  // TODO(010): history timeline, accuracy from feedback labels, and the creator leaderboard.
  // Blocked on nothing except persistence being wired — see 008's checklist.
}

void render()
