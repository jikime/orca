import { sql, type Kysely } from 'kysely'
import { loadAgentSessionTx, type AgentSession } from './agent-session-store'
import { allowedVisibilitiesForScope, type VisibilityScope } from './agent-visibility-scope'
import type { Database } from './database-schema'
import type { ProvenanceKind, ProvenanceTrustDomain } from './agent-provenance-projection'
import { withTenantTransaction } from './tenant-transaction'

// R5 slice 4a: the provenance read (doc 19 :265-271). A session's commits, PRs/MRs, test/build
// results, artifacts, and file changes surface with their trust domain and links, newest-first,
// cursor-paged. trust_domain is returned verbatim AND distilled into `verifiedEvidence` so a
// caller can never treat a `declared` agent claim as a verified/observed result (CAP-005): a
// declared claim has verifiedEvidence=false; local_observed and server_verified remain distinct.

export type AgentProvenanceView = {
  id: string
  sourceEventId: string
  kind: ProvenanceKind
  trustDomain: ProvenanceTrustDomain
  // True when this is first-hand evidence Pie observed or a provider/CI verified — NOT a mere
  // agent/user claim. `declared` → false; local_observed and server_verified → true.
  verifiedEvidence: boolean
  agentRunId: string | null
  provider: string | null
  repository: string | null
  sourceRevision: string | null
  commitSha: string | null
  changeRequest: {
    ref: string
    url: string | null
    state: string | null
    sourceBranch: string | null
    targetBranch: string | null
  } | null
  execution: {
    command: string
    execEnvironment: string | null
    exitCode: number | null
    parserVersion: string | null
  } | null
  fileChange: { path: string; changeType: string | null } | null
  artifactId: string | null
  contentHash: string | null
  workItemId: string | null
  revision: number
  correctsProvenanceId: string | null
  occurredAt: string
  receivedAt: string
}

export type AgentSessionProvenance = {
  session: AgentSession
  items: AgentProvenanceView[]
  nextCursor: string | null
}

const CURSOR_SEPARATOR = '|'

function encodeCursor(receivedAt: string, id: string): string {
  return Buffer.from(`${receivedAt}${CURSOR_SEPARATOR}${id}`).toString('base64url')
}

function decodeCursor(cursor: string): { receivedAt: string; id: string } | null {
  const [receivedAt, id] = Buffer.from(cursor, 'base64url')
    .toString('utf-8')
    .split(CURSOR_SEPARATOR)
  if (receivedAt === undefined || id === undefined) {
    return null
  }
  return { receivedAt, id }
}

type ProvenanceRow = {
  id: string
  source_event_id: string
  kind: string
  trust_domain: string
  agent_run_id: string | null
  provider: string | null
  repository: string | null
  source_revision: string | null
  commit_sha: string | null
  change_request_ref: string | null
  change_request_url: string | null
  change_request_state: string | null
  source_branch: string | null
  target_branch: string | null
  command: string | null
  exec_environment: string | null
  exit_code: number | null
  result_parser_version: string | null
  file_path: string | null
  change_type: string | null
  artifact_id: string | null
  content_hash: string | null
  work_item_id: string | null
  revision: number
  corrects_provenance_id: string | null
  occurred_at: Date | string
  received_at: Date | string
}

function toView(row: ProvenanceRow): AgentProvenanceView {
  const trustDomain = row.trust_domain as ProvenanceTrustDomain
  return {
    id: row.id,
    sourceEventId: row.source_event_id,
    kind: row.kind as ProvenanceKind,
    trustDomain,
    // The single load-bearing separation: a declared claim is never verified evidence.
    verifiedEvidence: trustDomain !== 'declared',
    agentRunId: row.agent_run_id,
    provider: row.provider,
    repository: row.repository,
    sourceRevision: row.source_revision,
    commitSha: row.commit_sha,
    changeRequest:
      row.change_request_ref !== null
        ? {
            ref: row.change_request_ref,
            url: row.change_request_url,
            state: row.change_request_state,
            sourceBranch: row.source_branch,
            targetBranch: row.target_branch
          }
        : null,
    execution:
      row.command !== null
        ? {
            command: row.command,
            execEnvironment: row.exec_environment,
            exitCode: row.exit_code,
            parserVersion: row.result_parser_version
          }
        : null,
    fileChange:
      row.file_path !== null ? { path: row.file_path, changeType: row.change_type } : null,
    artifactId: row.artifact_id,
    contentHash: row.content_hash,
    workItemId: row.work_item_id,
    revision: Number(row.revision),
    correctsProvenanceId: row.corrects_provenance_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    receivedAt: new Date(row.received_at).toISOString()
  }
}

/**
 * Reads a session's provenance, newest-first, keyset-paged by an opaque (received_at, id)
 * cursor. Returns null if the session is not visible in this org (RLS-scoped). Declared claims
 * are included but flagged verifiedEvidence=false so callers can filter them out of evidence.
 */
export async function listSessionProvenance(
  db: Kysely<Database>,
  organizationId: string,
  sessionId: string,
  options: { limit?: number; cursor?: string | null; scope?: VisibilityScope } = {}
): Promise<AgentSessionProvenance | null> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200)
  const cursor = options.cursor ? decodeCursor(options.cursor) : null
  // Default-deny: an unspecified scope reads at the narrowest audience (`customer`). Provenance
  // above the requested scope is ABSENT — filtered by the SOURCE EVENT's visibility (each
  // provenance row derives from exactly one append-only event via source_event_id).
  const scope = options.scope ?? 'customer'
  const allowedVisibilities = allowedVisibilitiesForScope(scope)
  return withTenantTransaction(db, organizationId, async (trx) => {
    const session = await loadAgentSessionTx(trx, sessionId)
    if (!session) {
      return null
    }
    // All rows of one batch share the tx `now()`, so keyset on received_at needs the id
    // tie-break; page at millisecond precision because the cursor round-trips through an
    // ISO-ms string (the DB value's microseconds cannot be reconstructed from a JS Date).
    const receivedAtMs = sql<Date>`date_trunc('milliseconds', p.received_at)`
    const cursorReceivedAt = cursor ? new Date(cursor.receivedAt) : null
    let query = trx
      .selectFrom('execution.agent_provenance as p')
      .innerJoin('execution.agent_events as ev', (join) =>
        join
          .onRef('ev.organization_id', '=', 'p.organization_id')
          .onRef('ev.event_id', '=', 'p.source_event_id')
      )
      .selectAll('p')
      .where('p.agent_session_id', '=', sessionId)
      .where('ev.visibility', 'in', allowedVisibilities)
    if (cursor && cursorReceivedAt) {
      query = query.where((eb) =>
        eb.or([
          eb(receivedAtMs, '<', cursorReceivedAt),
          eb.and([eb(receivedAtMs, '=', cursorReceivedAt), eb('p.id', '<', cursor.id)])
        ])
      )
    }
    const rows = await query
      .orderBy(receivedAtMs, 'desc')
      .orderBy('p.id', 'desc')
      .limit(limit + 1)
      .execute()

    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const last = pageRows.at(-1)
    const nextCursor =
      hasMore && last ? encodeCursor(new Date(last.received_at).toISOString(), last.id) : null

    return {
      session,
      items: pageRows.map((row) => toView(row as ProvenanceRow)),
      nextCursor
    }
  })
}
