import { sql, type Kysely } from 'kysely'
import type { Database } from './database-schema'
import { toDateString } from './planning-date'
import { auditPlanning, emitPlanningChange } from './planning-resource-change'
import { withTenantTransaction } from './tenant-transaction'

// R6 slice 4: the WBS (Work Breakdown Structure) tree — the planned-schedule backbone. A node
// belongs to a project by OPAQUE project_id and a leaf may map to a delivery work item by OPAQUE
// work_item_id (no cross-schema FK). The tree itself is an in-schema self-reference (parent_id).
// Two rules live here: the cycle guard on move (a node can never become its own descendant) and
// the summary rollup on read (a summary's dates/effort are aggregated from its subtree, not stored).

export type WbsNodeType = 'summary' | 'task' | 'deliverable'
export type WbsNodeStatus = 'planned' | 'in_progress' | 'done' | 'cancelled'

export type WbsNodeResource = {
  id: string
  organizationId: string
  projectId: string
  parentId: string | null
  wbsCode: string
  name: string
  nodeType: WbsNodeType
  sortOrder: number
  status: WbsNodeStatus
  plannedStart: string | null
  plannedEnd: string | null
  plannedEffortHours: string | null
  workItemId: string | null
  version: number
  createdAt: string
  updatedAt: string
}

// The rolled-up planned schedule of a node's whole subtree — computed on read, never stored.
export type WbsRollup = {
  plannedStart: string | null
  plannedEnd: string | null
  plannedEffortHours: string | null
}

export type WbsTreeNode = WbsNodeResource & {
  rollup: WbsRollup
  children: WbsTreeNode[]
}

type WbsNodeRow = {
  id: string
  organization_id: string
  project_id: string
  parent_id: string | null
  wbs_code: string
  name: string
  node_type: string
  sort_order: number
  status: string
  planned_start: Date | string | null
  planned_end: Date | string | null
  planned_effort_hours: string | null
  work_item_id: string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}

function mapNode(row: WbsNodeRow): WbsNodeResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    parentId: row.parent_id,
    wbsCode: row.wbs_code,
    name: row.name,
    nodeType: row.node_type as WbsNodeType,
    sortOrder: row.sort_order,
    status: row.status as WbsNodeStatus,
    plannedStart: toDateString(row.planned_start),
    plannedEnd: toDateString(row.planned_end),
    plannedEffortHours: row.planned_effort_hours === null ? null : String(row.planned_effort_hours),
    workItemId: row.work_item_id,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

export type CreateWbsNodeResult =
  | { ok: true; node: WbsNodeResource }
  | { ok: false; reason: 'parent_not_found' }
  | { ok: false; reason: 'duplicate_code' }

/**
 * Creates a WBS node. A root node passes parentId=null; a child's parent must already exist in the
 * SAME project (checked here so a node never joins another project's tree). wbs_code is unique per
 * project. Summary nodes typically omit planned dates/effort and have them rolled up on read.
 */
export async function createWbsNode(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    projectId: string
    parentId?: string | null
    wbsCode: string
    name: string
    nodeType?: WbsNodeType
    sortOrder?: number
    plannedStart?: string | null
    plannedEnd?: string | null
    plannedEffortHours?: number | string | null
    workItemId?: string | null
    status?: WbsNodeStatus
  }
): Promise<CreateWbsNodeResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    if (input.parentId) {
      const parent = await trx
        .selectFrom('planning.wbs_nodes')
        .select(['id', 'project_id'])
        .where('id', '=', input.parentId)
        .executeTakeFirst()
      // A child's parent must be a node in the same project — never another project's tree.
      if (!parent || parent.project_id !== input.projectId) {
        return { ok: false, reason: 'parent_not_found' }
      }
    }
    const duplicate = await trx
      .selectFrom('planning.wbs_nodes')
      .select('id')
      .where('project_id', '=', input.projectId)
      .where('wbs_code', '=', input.wbsCode)
      .executeTakeFirst()
    if (duplicate) {
      return { ok: false, reason: 'duplicate_code' }
    }
    const row = await trx
      .insertInto('planning.wbs_nodes')
      .values({
        organization_id: input.organizationId,
        project_id: input.projectId,
        parent_id: input.parentId ?? null,
        wbs_code: input.wbsCode,
        name: input.name,
        node_type: input.nodeType ?? 'task',
        sort_order: input.sortOrder ?? 0,
        planned_start: input.plannedStart ?? null,
        planned_end: input.plannedEnd ?? null,
        planned_effort_hours: input.plannedEffortHours ?? null,
        work_item_id: input.workItemId ?? null,
        status: input.status ?? 'planned'
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditPlanning(
      trx,
      input.organizationId,
      input.actorUserId,
      'planning.wbs_node.created',
      'wbs_node',
      row.id
    )
    await emitPlanningChange(trx, input.organizationId, 'wbs_node', row.id, 1, 'created')
    return { ok: true, node: mapNode(row) }
  })
}

export type WbsNodeMutationResult =
  | { ok: true; node: WbsNodeResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }

/** Edits a node's own planned fields under OCC (leaves store their own dates/effort). */
export async function updateWbsNode(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    nodeId: string
    expectedVersion: number
    name?: string
    nodeType?: WbsNodeType
    plannedStart?: string | null
    plannedEnd?: string | null
    plannedEffortHours?: number | string | null
    workItemId?: string | null
    status?: WbsNodeStatus
  }
): Promise<WbsNodeMutationResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('planning.wbs_nodes')
      .selectAll()
      .where('id', '=', input.nodeId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('planning.wbs_nodes')
      .set({
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.nodeType === undefined ? {} : { node_type: input.nodeType }),
        ...(input.plannedStart === undefined ? {} : { planned_start: input.plannedStart }),
        ...(input.plannedEnd === undefined ? {} : { planned_end: input.plannedEnd }),
        ...(input.plannedEffortHours === undefined
          ? {}
          : { planned_effort_hours: input.plannedEffortHours }),
        ...(input.workItemId === undefined ? {} : { work_item_id: input.workItemId }),
        ...(input.status === undefined ? {} : { status: input.status })
      })
      .where('id', '=', input.nodeId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditPlanning(
      trx,
      input.organizationId,
      input.actorUserId,
      'planning.wbs_node.updated',
      'wbs_node',
      input.nodeId
    )
    await emitPlanningChange(
      trx,
      input.organizationId,
      'wbs_node',
      input.nodeId,
      newVersion,
      'updated'
    )
    return { ok: true, node: mapNode(updated) }
  })
}

export type MoveWbsNodeResult =
  | { ok: true; node: WbsNodeResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'parent_not_found' }
  // The move would make the node its own ancestor — rejected to keep the tree acyclic.
  | { ok: false; reason: 'cycle' }

/**
 * Moves a node: reparent (+ reorder) under OCC. The cycle guard walks the ancestor chain of the
 * NEW parent — if the moved node appears in it (or the parent IS the node), the move is refused, so
 * a node can never become its own descendant. Reparenting stays within the node's project.
 */
export async function moveWbsNode(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    nodeId: string
    newParentId: string | null
    sortOrder?: number
    expectedVersion: number
  }
): Promise<MoveWbsNodeResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('planning.wbs_nodes')
      .selectAll()
      .where('id', '=', input.nodeId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    if (input.newParentId) {
      if (input.newParentId === input.nodeId) {
        return { ok: false, reason: 'cycle' }
      }
      const parent = await trx
        .selectFrom('planning.wbs_nodes')
        .select(['id', 'project_id', 'parent_id'])
        .where('id', '=', input.newParentId)
        .executeTakeFirst()
      if (!parent || parent.project_id !== current.project_id) {
        return { ok: false, reason: 'parent_not_found' }
      }
      // Walk up from the new parent; if we reach the moved node, the move would form a cycle.
      let cursor: string | null = parent.parent_id
      const seen = new Set<string>([parent.id])
      while (cursor) {
        if (cursor === input.nodeId) {
          return { ok: false, reason: 'cycle' }
        }
        if (seen.has(cursor)) {
          break
        }
        seen.add(cursor)
        const next: { parent_id: string | null } | undefined = await trx
          .selectFrom('planning.wbs_nodes')
          .select('parent_id')
          .where('id', '=', cursor)
          .executeTakeFirst()
        cursor = next?.parent_id ?? null
      }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('planning.wbs_nodes')
      .set({
        parent_id: input.newParentId,
        version: newVersion,
        updated_at: sql`now()`,
        ...(input.sortOrder === undefined ? {} : { sort_order: input.sortOrder })
      })
      .where('id', '=', input.nodeId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await auditPlanning(
      trx,
      input.organizationId,
      input.actorUserId,
      'planning.wbs_node.moved',
      'wbs_node',
      input.nodeId
    )
    await emitPlanningChange(
      trx,
      input.organizationId,
      'wbs_node',
      input.nodeId,
      newVersion,
      'updated'
    )
    return { ok: true, node: mapNode(updated) }
  })
}

export async function getWbsNode(
  db: Kysely<Database>,
  organizationId: string,
  nodeId: string
): Promise<WbsNodeResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('planning.wbs_nodes')
      .selectAll()
      .where('id', '=', nodeId)
      .executeTakeFirst()
    return row ? mapNode(row) : null
  })
}

// Sums numeric effort strings, treating null as absent; returns a 2-decimal string or null.
function sumEffort(values: (string | null)[]): string | null {
  let total: number | null = null
  for (const value of values) {
    if (value !== null) {
      total = (total ?? 0) + Number(value)
    }
  }
  return total === null ? null : total.toFixed(2)
}

// min/max over ISO date strings ('YYYY-MM-DD' sorts chronologically), ignoring nulls.
function extremeDate(values: (string | null)[], pick: 'min' | 'max'): string | null {
  let result: string | null = null
  for (const value of values) {
    if (value === null) {
      continue
    }
    if (result === null || (pick === 'min' ? value < result : value > result)) {
      result = value
    }
  }
  return result
}

// Builds a node's subtree and its rollup. A node WITH children rolls its planned schedule up from
// the children's rollups (a summary's dates/effort are derived, not stored); a leaf's rollup is its
// own stored values.
function buildSubtree(
  node: WbsNodeResource,
  childrenById: Map<string, WbsNodeResource[]>
): WbsTreeNode {
  const kids = (childrenById.get(node.id) ?? []).map((child) => buildSubtree(child, childrenById))
  const rollup: WbsRollup =
    kids.length === 0
      ? {
          plannedStart: node.plannedStart,
          plannedEnd: node.plannedEnd,
          plannedEffortHours: node.plannedEffortHours
        }
      : {
          plannedStart: extremeDate(
            kids.map((k) => k.rollup.plannedStart),
            'min'
          ),
          plannedEnd: extremeDate(
            kids.map((k) => k.rollup.plannedEnd),
            'max'
          ),
          plannedEffortHours: sumEffort(kids.map((k) => k.rollup.plannedEffortHours))
        }
  return { ...node, rollup, children: kids }
}

/** Reads the project's WBS as a nested tree with summary dates/effort rolled up from each subtree. */
export async function getWbsTree(
  db: Kysely<Database>,
  organizationId: string,
  projectId: string
): Promise<WbsTreeNode[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('planning.wbs_nodes')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('sort_order', 'asc')
      .orderBy('wbs_code', 'asc')
      .orderBy('id', 'asc')
      .execute()
    const nodes = rows.map(mapNode)
    const childrenById = new Map<string, WbsNodeResource[]>()
    const roots: WbsNodeResource[] = []
    for (const node of nodes) {
      if (node.parentId === null) {
        roots.push(node)
      } else {
        const siblings = childrenById.get(node.parentId) ?? []
        siblings.push(node)
        childrenById.set(node.parentId, siblings)
      }
    }
    return roots.map((root) => buildSubtree(root, childrenById))
  })
}
