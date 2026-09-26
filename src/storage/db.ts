/**
 * IndexedDB access.
 *
 * THE footgun in this layer: an IDB transaction auto-closes the moment the task queue yields to
 * something that is not an IDB request. `await fetch(...)`, `await chrome.storage.get(...)`, even
 * `await Promise.resolve()` inside an open transaction will silently kill it, and the write
 * vanishes with no error.
 *
 * The defence here is structural rather than a comment telling you to be careful: `withTx` takes
 * a SYNCHRONOUS callback. You cannot await anything foreign inside a transaction through this
 * module's public API, because there is nowhere to put the await.
 */

import { DB_NAME, DB_VERSION, STORE, createStores, toExcerpt } from './schema'
import type { AuthorAggregate, StoredLabel, StoredVerdict } from './schema'
import type { Axis, TriageBand, Verdict } from '../core/types'

let dbPromise: Promise<IDBDatabase> | null = null

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => createStores(req.result)
    req.onsuccess = () => {
      const db = req.result
      // If another context upgrades the schema, close ours so it is not blocked, and drop the
      // cached promise so the next call reopens at the new version.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
  return dbPromise
}

/** Test hook. Production code never needs this. */
export function resetDbHandleForTests(): void {
  dbPromise = null
}

/**
 * Run `fn` inside one transaction and resolve when it commits.
 *
 * `fn` is synchronous ON PURPOSE — see the module comment. Queue your IDB requests and let the
 * transaction's own `oncomplete` be the signal, rather than awaiting each request in turn.
 */
async function withTx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => T,
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode)
    let out: T
    try {
      out = fn(tx)
    } catch (e) {
      tx.abort()
      reject(e)
      return
    }
    tx.oncomplete = () => resolve(out)
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

export interface RecordVerdictInput {
  verdict: Verdict
  cacheKey: string
  authorUrn: string
  authorName: string
  text: string
  /** What the router decided, for the agreement panel. */
  triageBand?: TriageBand
  /** Epoch ms. Injected rather than read here, so callers control time and tests stay deterministic. */
  at: number
}

/**
 * Write a verdict and update the author's aggregate **in one transaction**.
 *
 * Atomicity matters: a verdict counted in the timeline but missing from the aggregate would make
 * the leaderboard quietly disagree with the history, and nothing would ever notice.
 */
export async function recordVerdict(input: RecordVerdictInput): Promise<void> {
  const { verdict, cacheKey, authorUrn, authorName, text, at } = input

  const scores = Object.values(verdict.signals)
    .map((s) => s?.score ?? 0)
    .filter((n) => Number.isFinite(n))
  const topScore = scores.length > 0 ? Math.max(...scores) : 0

  const row: StoredVerdict = {
    key: cacheKey,
    postId: verdict.postId,
    authorUrn,
    authorName,
    excerpt: toExcerpt(text),
    action: verdict.action,
    triggeredBy: verdict.triggeredBy,
    topScore,
    signals: verdict.signals as StoredVerdict['signals'],
    engineId: verdict.engineId,
    rulesVersion: verdict.rulesVersion,
    ...(input.triageBand ? { triageBand: input.triageBand } : {}),
    at,
  }

  await withTx([STORE.verdicts, STORE.authors], 'readwrite', (tx) => {
    const verdicts = tx.objectStore(STORE.verdicts)
    const authors = tx.objectStore(STORE.authors)

    // Read-before-write to avoid double-counting a re-scored post. Callback style, not await:
    // awaiting here would end the transaction before the aggregate write was queued.
    const existing = verdicts.get(cacheKey)
    existing.onsuccess = () => {
      const alreadyCounted = existing.result !== undefined
      verdicts.put(row)

      const agg = authors.get(authorUrn)
      agg.onsuccess = () => {
        const prev = agg.result as AuthorAggregate | undefined
        const flagged = row.action === 'collapse' ? 1 : 0
        const next: AuthorAggregate = prev
          ? {
              ...prev,
              authorName,
              postsSeen: prev.postsSeen + (alreadyCounted ? 0 : 1),
              postsFlagged: prev.postsFlagged + (alreadyCounted ? 0 : flagged),
              scoreSum: prev.scoreSum + (alreadyCounted ? 0 : topScore),
              lastSeen: Math.max(prev.lastSeen, at),
            }
          : {
              authorUrn,
              authorName,
              postsSeen: 1,
              postsFlagged: flagged,
              scoreSum: topScore,
              firstSeen: at,
              lastSeen: at,
            }
        authors.put(next)
      }
    }
  })
}

export async function getVerdict(cacheKey: string): Promise<StoredVerdict | undefined> {
  const db = await openDb()
  const tx = db.transaction(STORE.verdicts, 'readonly')
  return request(tx.objectStore(STORE.verdicts).get(cacheKey) as IDBRequest<StoredVerdict>)
}

/** Most recent verdicts first. Backs the dashboard timeline. */
export async function recentVerdicts(limit = 100, onlyCollapsed = false): Promise<StoredVerdict[]> {
  const db = await openDb()
  const tx = db.transaction(STORE.verdicts, 'readonly')
  const index = tx.objectStore(STORE.verdicts).index('at')
  return new Promise((resolve, reject) => {
    const out: StoredVerdict[] = []
    const cursorReq = index.openCursor(null, 'prev')
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor || out.length >= limit) {
        resolve(out)
        return
      }
      const row = cursor.value as StoredVerdict
      if (!onlyCollapsed || row.action === 'collapse') out.push(row)
      cursor.continue()
    }
    cursorReq.onerror = () => reject(cursorReq.error)
  })
}

export async function allAuthors(): Promise<AuthorAggregate[]> {
  const db = await openDb()
  const tx = db.transaction(STORE.authors, 'readonly')
  return request(tx.objectStore(STORE.authors).getAll() as IDBRequest<AuthorAggregate[]>)
}

export async function putLabel(label: Omit<StoredLabel, 'key'>): Promise<void> {
  const row: StoredLabel = { ...label, key: `${label.postId}:${label.axis}` }
  await withTx([STORE.labels], 'readwrite', (tx) => {
    tx.objectStore(STORE.labels).put(row)
  })
}

export async function labelsForAxis(axis: Axis): Promise<StoredLabel[]> {
  const db = await openDb()
  const tx = db.transaction(STORE.labels, 'readonly')
  const index = tx.objectStore(STORE.labels).index('axis')
  return request(index.getAll(axis) as IDBRequest<StoredLabel[]>)
}

/**
 * Delete verdicts older than `before` (epoch ms).
 *
 * Retention is a real obligation, not a nicety: this is other people's writing, stored on the
 * user's disk. Returns the number deleted so the caller can log or surface it.
 */
export async function purgeOlderThan(before: number): Promise<number> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE.verdicts, 'readwrite')
    const index = tx.objectStore(STORE.verdicts).index('at')
    let deleted = 0
    const cursorReq = index.openCursor(IDBKeyRange.upperBound(before, true))
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor) return
      cursor.delete()
      deleted++
      cursor.continue()
    }
    tx.oncomplete = () => resolve(deleted)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/**
 * Delete everything. Wired to a dashboard control — a local-only product still owes the user a
 * one-click way to remove what it has collected.
 */
export async function purgeAll(): Promise<void> {
  await withTx([STORE.verdicts, STORE.authors, STORE.labels], 'readwrite', (tx) => {
    tx.objectStore(STORE.verdicts).clear()
    tx.objectStore(STORE.authors).clear()
    tx.objectStore(STORE.labels).clear()
  })
}
