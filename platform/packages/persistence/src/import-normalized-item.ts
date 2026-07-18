// R6 slice 6: the source-agnostic import record. The desktop/connector normalizes Jira, Redmine, or
// CSV upstream into this ONE shape, so the store and every source parser share a single vocabulary
// and the dedup/apply path never forks per source.

export type NormalizedImportKind = 'project' | 'work_item'

export type NormalizedImportItem = {
  externalSystem: string
  externalKey: string
  kind: NormalizedImportKind
  title: string
  summary?: string | null
  description?: string | null
  status?: string | null
  priority?: string | null
  // work_item only: the target team (falls back to the request-level default team). A work item with
  // no resolvable team is a SKIP, never a hard failure of the whole import.
  teamId?: string | null
  // work_item only: mapped to an EXISTING org user by email; unmapped → left unassigned (users are
  // never created, so re-import cannot duplicate users).
  assigneeEmail?: string | null
}

export type ImportSource = 'jira' | 'redmine' | 'csv'
