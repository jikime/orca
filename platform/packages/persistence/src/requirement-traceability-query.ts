import { type Kysely, type Transaction } from 'kysely'
import type { ProvenanceKind, ProvenanceTrustDomain } from './agent-provenance-projection'
import type { Database } from './database-schema'
import {
  listRequirementAcceptances,
  mapRequirement,
  type RequirementAcceptanceResource,
  type RequirementResource
} from './requirement-store'
import { withTenantTransaction } from './tenant-transaction'

// R6 slice 2 — the traceability READ that realizes the exit condition "요구사항이 작업, 코드, 테스트,
// 산출물, 검수까지 추적된다." It walks a requirement → its crm contract scope line → the delivery work
// items that implement it → for each work item its execution.agent_provenance evidence (code/test/
// build/artifact) → its acceptance (검수) records, and distills a coverage view flagging GAPs.
//
// verified-vs-declared: evidence carries R5 trust_domain, and verifiedEvidence reuses the R5 rule
// (a `declared` agent/user CLAIM is NEVER evidence — CAP-005). Coverage counts ONLY verified
// evidence, so a declared-only test claim does not close the test gap.

export type RequirementScopeTrace = {
  id: string
  contractId: string
  serviceType: string
  description: string | null
  quantity: string
  rate: string
  sortKey: number
}

export type RequirementWorkItemTrace = {
  id: string
  identifier: string
  title: string
  stateId: string
  projectId: string | null
  assigneeId: string | null
}

export type RequirementEvidence = {
  id: string
  kind: ProvenanceKind
  trustDomain: ProvenanceTrustDomain
  // Mirrors agent-provenance-query: a `declared` claim is never verified evidence.
  verifiedEvidence: boolean
  workItemId: string
  commitSha: string | null
  changeRequestRef: string | null
  command: string | null
  exitCode: number | null
  artifactId: string | null
  filePath: string | null
  occurredAt: string
}

export type RequirementWorkItemLinkTrace = {
  linkId: string
  workItemId: string
  workItem: RequirementWorkItemTrace | null
  evidence: RequirementEvidence[]
}

export type RequirementCoverage = {
  hasWorkItem: boolean
  hasCodeEvidence: boolean
  hasTestEvidence: boolean
  hasBuildEvidence: boolean
  hasDeliverableEvidence: boolean
  hasAcceptance: boolean
  // The chain is fully traced only when work, code, test, deliverable (산출물), AND acceptance
  // (검수) are all present with VERIFIED evidence; missing any one makes the requirement a GAP.
  isFullyTraced: boolean
  gaps: string[]
}

export type RequirementTraceability = {
  requirement: RequirementResource
  contractScopeItem: RequirementScopeTrace | null
  workItems: RequirementWorkItemLinkTrace[]
  acceptances: RequirementAcceptanceResource[]
  coverage: RequirementCoverage
}

type ProvenanceEvidenceRow = {
  id: string
  kind: string
  trust_domain: string
  work_item_id: string
  commit_sha: string | null
  change_request_ref: string | null
  command: string | null
  exit_code: number | null
  artifact_id: string | null
  file_path: string | null
  occurred_at: Date | string
}

function toEvidence(row: ProvenanceEvidenceRow): RequirementEvidence {
  const trustDomain = row.trust_domain as ProvenanceTrustDomain
  return {
    id: row.id,
    kind: row.kind as ProvenanceKind,
    trustDomain,
    verifiedEvidence: trustDomain !== 'declared',
    workItemId: row.work_item_id,
    commitSha: row.commit_sha,
    changeRequestRef: row.change_request_ref,
    command: row.command,
    exitCode: row.exit_code,
    artifactId: row.artifact_id,
    filePath: row.file_path,
    occurredAt: new Date(row.occurred_at).toISOString()
  }
}

// A verified evidence kind is one whose trust_domain is not `declared` (R5 CAP-005). Coverage is
// computed over this set: declared claims are excluded so they never close a gap.
function computeCoverage(
  hasWorkItem: boolean,
  verifiedKinds: Set<ProvenanceKind>,
  hasAcceptance: boolean
): RequirementCoverage {
  const hasCodeEvidence =
    verifiedKinds.has('commit') ||
    verifiedKinds.has('file_change') ||
    verifiedKinds.has('pull_request')
  const hasTestEvidence = verifiedKinds.has('test_result')
  const hasBuildEvidence = verifiedKinds.has('build_result')
  // 산출물 (deliverable): a produced artifact, or a build output.
  const hasDeliverableEvidence = verifiedKinds.has('artifact') || hasBuildEvidence
  const gaps: string[] = []
  if (!hasWorkItem) gaps.push('no_work_item')
  if (!hasCodeEvidence) gaps.push('no_code_evidence')
  if (!hasTestEvidence) gaps.push('no_test_evidence')
  if (!hasDeliverableEvidence) gaps.push('no_deliverable_evidence')
  if (!hasAcceptance) gaps.push('no_acceptance')
  return {
    hasWorkItem,
    hasCodeEvidence,
    hasTestEvidence,
    hasBuildEvidence,
    hasDeliverableEvidence,
    hasAcceptance,
    isFullyTraced: gaps.length === 0,
    gaps
  }
}

async function loadWorkItemLinks(
  trx: Transaction<Database>,
  requirementId: string
): Promise<{ linkId: string; workItemId: string }[]> {
  const rows = await trx
    .selectFrom('requirements.requirement_work_items')
    .select(['id', 'work_item_id'])
    .where('requirement_id', '=', requirementId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute()
  return rows.map((row) => ({ linkId: row.id, workItemId: row.work_item_id }))
}

// Pull provenance evidence for a set of opaque work_item_ids via a focused join into the execution
// schema in the SAME tenant tx (RLS-scoped). Keyed by work_item_id (not session, as the R5 read is),
// so a focused join is used rather than listSessionProvenance; the verified-vs-declared distinction
// is preserved verbatim from the row's trust_domain.
async function loadEvidenceByWorkItem(
  trx: Transaction<Database>,
  workItemIds: string[]
): Promise<Map<string, RequirementEvidence[]>> {
  const byWorkItem = new Map<string, RequirementEvidence[]>()
  if (workItemIds.length === 0) {
    return byWorkItem
  }
  const rows = await trx
    .selectFrom('execution.agent_provenance')
    .select([
      'id',
      'kind',
      'trust_domain',
      'work_item_id',
      'commit_sha',
      'change_request_ref',
      'command',
      'exit_code',
      'artifact_id',
      'file_path',
      'occurred_at'
    ])
    .where('work_item_id', 'in', workItemIds)
    .orderBy('occurred_at', 'asc')
    .orderBy('id', 'asc')
    .execute()
  for (const row of rows) {
    const evidence = toEvidence(row as ProvenanceEvidenceRow)
    const list = byWorkItem.get(evidence.workItemId)
    if (list) {
      list.push(evidence)
    } else {
      byWorkItem.set(evidence.workItemId, [evidence])
    }
  }
  return byWorkItem
}

/**
 * The full traceability chain for one requirement, or null if it is not visible in this org. Returns
 * the requirement, the crm scope line it realizes (resolved opaquely), each linked work item with its
 * verified/declared evidence, the acceptance records, and the coverage/gap summary.
 */
export async function getRequirementTraceability(
  db: Kysely<Database>,
  organizationId: string,
  requirementId: string
): Promise<RequirementTraceability | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const requirementRow = await trx
      .selectFrom('requirements.requirements')
      .selectAll()
      .where('id', '=', requirementId)
      .executeTakeFirst()
    if (!requirementRow) {
      return null
    }
    const requirement = mapRequirement(requirementRow)

    let contractScopeItem: RequirementScopeTrace | null = null
    if (requirement.contractScopeItemId) {
      const scopeRow = await trx
        .selectFrom('crm.contract_scope_items')
        .select([
          'id',
          'contract_id',
          'service_type',
          'description',
          'quantity',
          'rate',
          'sort_key'
        ])
        .where('id', '=', requirement.contractScopeItemId)
        .executeTakeFirst()
      if (scopeRow) {
        contractScopeItem = {
          id: scopeRow.id,
          contractId: scopeRow.contract_id,
          serviceType: scopeRow.service_type,
          description: scopeRow.description,
          quantity: String(scopeRow.quantity),
          rate: String(scopeRow.rate),
          sortKey: scopeRow.sort_key
        }
      }
    }

    const links = await loadWorkItemLinks(trx, requirementId)
    const workItemIds = links.map((link) => link.workItemId)
    const workItemRows =
      workItemIds.length > 0
        ? await trx
            .selectFrom('delivery.work_items')
            .select(['id', 'identifier', 'title', 'state_id', 'project_id', 'assignee_id'])
            .where('id', 'in', workItemIds)
            .execute()
        : []
    const workItemById = new Map<string, RequirementWorkItemTrace>()
    for (const row of workItemRows) {
      workItemById.set(row.id, {
        id: row.id,
        identifier: row.identifier,
        title: row.title,
        stateId: row.state_id,
        projectId: row.project_id,
        assigneeId: row.assignee_id
      })
    }
    const evidenceByWorkItem = await loadEvidenceByWorkItem(trx, workItemIds)

    const verifiedKinds = new Set<ProvenanceKind>()
    const workItems: RequirementWorkItemLinkTrace[] = links.map((link) => {
      const evidence = evidenceByWorkItem.get(link.workItemId) ?? []
      for (const item of evidence) {
        if (item.verifiedEvidence) {
          verifiedKinds.add(item.kind)
        }
      }
      return {
        linkId: link.linkId,
        workItemId: link.workItemId,
        workItem: workItemById.get(link.workItemId) ?? null,
        evidence
      }
    })

    const acceptances = await listRequirementAcceptances(db, organizationId, requirementId)
    // A positive 검수 = an acceptance whose result is not a failure.
    const hasAcceptance = acceptances.some((a) => a.result !== 'fail')
    const coverage = computeCoverage(workItems.length > 0, verifiedKinds, hasAcceptance)

    return { requirement, contractScopeItem, workItems, acceptances, coverage }
  })
}

export type RequirementCoverageItem = {
  requirement: RequirementResource
  coverage: RequirementCoverage
}

export type RequirementCoveragePage = {
  items: RequirementCoverageItem[]
  nextCursor: string | null
}

/**
 * A cursor-paged list of a project's requirements with their coverage status, so a PM sees which
 * requirements are untraced/unverified (a GAP). Aggregates work-item links, verified evidence, and
 * acceptances over the whole page in three grouped queries (not per-requirement N+1).
 */
export async function listRequirementCoverage(
  db: Kysely<Database>,
  organizationId: string,
  projectId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<RequirementCoveragePage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('requirements.requirements')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    const requirementIds = page.map((row) => row.id)
    if (requirementIds.length === 0) {
      return { items: [], nextCursor }
    }

    // (1) which requirements have at least one linked work item, and each work item id.
    const linkRows = await trx
      .selectFrom('requirements.requirement_work_items')
      .select(['requirement_id', 'work_item_id'])
      .where('requirement_id', 'in', requirementIds)
      .execute()
    const hasWorkItemByReq = new Set<string>()
    for (const link of linkRows) {
      hasWorkItemByReq.add(link.requirement_id)
    }

    // (2) verified evidence kinds per requirement, via requirement_work_items → agent_provenance on
    // the opaque work_item_id (same tenant). declared claims are read but excluded from coverage.
    const evidenceRows = await trx
      .selectFrom('requirements.requirement_work_items as rw')
      .innerJoin('execution.agent_provenance as p', (join) =>
        join
          .onRef('p.organization_id', '=', 'rw.organization_id')
          .onRef('p.work_item_id', '=', 'rw.work_item_id')
      )
      .select([
        'rw.requirement_id as requirement_id',
        'p.kind as kind',
        'p.trust_domain as trust_domain'
      ])
      .where('rw.requirement_id', 'in', requirementIds)
      .execute()
    const verifiedKindsByReq = new Map<string, Set<ProvenanceKind>>()
    for (const row of evidenceRows) {
      if (row.trust_domain === 'declared') {
        continue
      }
      const set = verifiedKindsByReq.get(row.requirement_id) ?? new Set<ProvenanceKind>()
      set.add(row.kind as ProvenanceKind)
      verifiedKindsByReq.set(row.requirement_id, set)
    }

    // (3) which requirements carry a positive acceptance (검수 result not a failure).
    const acceptanceRows = await trx
      .selectFrom('requirements.requirement_acceptances')
      .select(['requirement_id', 'result'])
      .where('requirement_id', 'in', requirementIds)
      .execute()
    const hasAcceptanceByReq = new Set<string>()
    for (const row of acceptanceRows) {
      if (row.result !== 'fail') {
        hasAcceptanceByReq.add(row.requirement_id)
      }
    }

    const items = page.map((row) => {
      const requirement = mapRequirement(row)
      const coverage = computeCoverage(
        hasWorkItemByReq.has(row.id),
        verifiedKindsByReq.get(row.id) ?? new Set<ProvenanceKind>(),
        hasAcceptanceByReq.has(row.id)
      )
      return { requirement, coverage }
    })
    return { items, nextCursor }
  })
}
