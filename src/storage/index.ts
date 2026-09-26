export { DB_NAME, DB_VERSION, STORE, EXCERPT_CHARS, toExcerpt } from './schema'
export type { StoredVerdict, AuthorAggregate, StoredLabel } from './schema'
export {
  openDb,
  recordVerdict,
  getVerdict,
  recentVerdicts,
  allAuthors,
  putLabel,
  labelsForAxis,
  purgeOlderThan,
  purgeAll,
} from './db'
export type { RecordVerdictInput } from './db'
export { rankOffenders, summarizeAgreement } from './aggregates'
export type { RankedAuthor, RankOptions, AccuracySummary } from './aggregates'
export {
  loadSettings,
  saveSettings,
  hasConsent,
  grantConsent,
  revokeConsent,
} from './settings'
