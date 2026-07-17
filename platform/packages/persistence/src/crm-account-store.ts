import { randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Database } from './database-schema'
import {
  buildResourceChangeCloudEvent,
  type ResourceChangeResourceType
} from './resource-change-event'
import { withTenantTransaction } from './tenant-transaction'

// R6 slice 1: the customer-360 aggregate (account + sites + contacts) and the sales pipeline
// (opportunities). Contracts and change orders live in crm-contract-store — this file owns the
// account graph and pipeline, the contract file owns the approval gate.

export type AccountStatus = 'prospect' | 'active' | 'inactive'
export type OpportunityStage = 'lead' | 'qualified' | 'proposal' | 'won' | 'lost'

export type AccountResource = {
  id: string
  organizationId: string
  name: string
  status: AccountStatus
  ownerUserId: string | null
  externalRef: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type AccountSiteResource = {
  id: string
  organizationId: string
  accountId: string
  name: string
  timezone: string
  createdAt: string
  updatedAt: string
}

export type AccountContactResource = {
  id: string
  organizationId: string
  accountId: string
  siteId: string | null
  name: string
  email: string | null
  role: string | null
  createdAt: string
}

export type OpportunityResource = {
  id: string
  organizationId: string
  accountId: string
  name: string
  stage: OpportunityStage
  amount: string
  probability: number | null
  ownerUserId: string | null
  expectedCloseAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

// The pipeline state machine (doc 13 Opportunity.stage). won/lost are terminal; every other
// stage may move forward or straight to lost. Kept explicit so an illegal jump is a typed reject.
const OPPORTUNITY_TRANSITIONS: Record<OpportunityStage, readonly OpportunityStage[]> = {
  lead: ['qualified', 'lost'],
  qualified: ['proposal', 'lost'],
  proposal: ['won', 'lost'],
  won: [],
  lost: []
}

export function isLegalOpportunityTransition(
  from: OpportunityStage,
  to: OpportunityStage
): boolean {
  return OPPORTUNITY_TRANSITIONS[from]?.includes(to) ?? false
}

function mapAccount(row: {
  id: string
  organization_id: string
  name: string
  status: string
  owner_user_id: string | null
  external_ref: string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}): AccountResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    status: row.status as AccountStatus,
    ownerUserId: row.owner_user_id,
    externalRef: row.external_ref,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

function mapSite(row: {
  id: string
  organization_id: string
  account_id: string
  name: string
  timezone: string
  created_at: Date | string
  updated_at: Date | string
}): AccountSiteResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    accountId: row.account_id,
    name: row.name,
    timezone: row.timezone,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

function mapContact(row: {
  id: string
  organization_id: string
  account_id: string
  site_id: string | null
  name: string
  email: string | null
  role: string | null
  created_at: Date | string
}): AccountContactResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    accountId: row.account_id,
    siteId: row.site_id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString()
  }
}

function mapOpportunity(row: {
  id: string
  organization_id: string
  account_id: string
  name: string
  stage: string
  amount: string | number
  probability: number | null
  owner_user_id: string | null
  expected_close_at: string | null
  version: string | number
  created_at: Date | string
  updated_at: Date | string
}): OpportunityResource {
  return {
    id: row.id,
    organizationId: row.organization_id,
    accountId: row.account_id,
    name: row.name,
    stage: row.stage as OpportunityStage,
    amount: String(row.amount),
    probability: row.probability,
    ownerUserId: row.owner_user_id,
    expectedCloseAt: row.expected_close_at,
    version: Number(row.version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  }
}

async function emitCrmChange(
  trx: Transaction<Database>,
  organizationId: string,
  resourceType: ResourceChangeResourceType,
  resourceId: string,
  version: number,
  changeKind: 'created' | 'updated'
): Promise<void> {
  const outboxId = randomUUID()
  const occurredAt = new Date().toISOString()
  const cloudEvent = buildResourceChangeCloudEvent({
    organizationId,
    eventId: outboxId,
    resourceType,
    resourceId,
    changeKind,
    version,
    occurredAt
  })
  await trx
    .insertInto('operations.outbox_events')
    .values({
      id: outboxId,
      organization_id: organizationId,
      aggregate_type: resourceType,
      aggregate_id: resourceId,
      aggregate_version: version,
      event_type: cloudEvent.type,
      event_schema_version: 1,
      payload: JSON.stringify(cloudEvent),
      occurred_at: occurredAt,
      available_at: occurredAt
    })
    .execute()
}

async function audit(
  trx: Transaction<Database>,
  organizationId: string,
  actorUserId: string,
  action: string,
  targetType: string,
  targetId: string
): Promise<void> {
  await trx
    .insertInto('audit.audit_events')
    .values({
      organization_id: organizationId,
      actor_id: actorUserId,
      action,
      target_type: targetType,
      target_id: targetId
    })
    .execute()
}

export async function createAccount(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    name: string
    status?: AccountStatus
    ownerUserId?: string | null
    externalRef?: string | null
  }
): Promise<AccountResource> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const row = await trx
      .insertInto('crm.accounts')
      .values({
        organization_id: input.organizationId,
        name: input.name,
        status: input.status ?? 'prospect',
        owner_user_id: input.ownerUserId ?? null,
        external_ref: input.externalRef ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      'crm.account.created',
      'crm_account',
      row.id
    )
    await emitCrmChange(trx, input.organizationId, 'crm_account', row.id, 1, 'created')
    return mapAccount(row)
  })
}

export async function getAccount(
  db: Kysely<Database>,
  organizationId: string,
  accountId: string
): Promise<AccountResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('crm.accounts')
      .selectAll()
      .where('id', '=', accountId)
      .executeTakeFirst()
    return row ? mapAccount(row) : null
  })
}

export type AccountPage = { items: AccountResource[]; nextCursor: string | null }

export async function listAccounts(
  db: Kysely<Database>,
  organizationId: string,
  options: { limit?: number; cursor?: string | null } = {}
): Promise<AccountPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withTenantTransaction(db, organizationId, async (trx) => {
    let query = trx
      .selectFrom('crm.accounts')
      .selectAll()
      .orderBy('id', 'asc')
      .limit(limit + 1)
    if (options.cursor) {
      query = query.where('id', '>', options.cursor)
    }
    const rows = await query.execute()
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const nextCursor = rows.length > limit && last ? last.id : null
    return { items: page.map(mapAccount), nextCursor }
  })
}

export type CreateSiteResult =
  | { ok: true; site: AccountSiteResource }
  | { ok: false; reason: 'account_not_found' }

export async function createAccountSite(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    accountId: string
    name: string
    timezone?: string
  }
): Promise<CreateSiteResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const account = await trx
      .selectFrom('crm.accounts')
      .select('id')
      .where('id', '=', input.accountId)
      .executeTakeFirst()
    if (!account) {
      return { ok: false, reason: 'account_not_found' }
    }
    const row = await trx
      .insertInto('crm.account_sites')
      .values({
        organization_id: input.organizationId,
        account_id: input.accountId,
        name: input.name,
        ...(input.timezone ? { timezone: input.timezone } : {})
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      'crm.account_site.created',
      'crm_account',
      input.accountId
    )
    await emitCrmChange(trx, input.organizationId, 'crm_account', input.accountId, 1, 'updated')
    return { ok: true, site: mapSite(row) }
  })
}

export async function listAccountSites(
  db: Kysely<Database>,
  organizationId: string,
  accountId: string
): Promise<AccountSiteResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('crm.account_sites')
      .selectAll()
      .where('account_id', '=', accountId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    return rows.map(mapSite)
  })
}

export type CreateContactResult =
  | { ok: true; contact: AccountContactResource }
  | { ok: false; reason: 'account_not_found' }

export async function createAccountContact(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    accountId: string
    siteId?: string | null
    name: string
    email?: string | null
    role?: string | null
  }
): Promise<CreateContactResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const account = await trx
      .selectFrom('crm.accounts')
      .select('id')
      .where('id', '=', input.accountId)
      .executeTakeFirst()
    if (!account) {
      return { ok: false, reason: 'account_not_found' }
    }
    const row = await trx
      .insertInto('crm.account_contacts')
      .values({
        organization_id: input.organizationId,
        account_id: input.accountId,
        site_id: input.siteId ?? null,
        name: input.name,
        email: input.email ?? null,
        role: input.role ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      'crm.account_contact.created',
      'crm_account',
      input.accountId
    )
    await emitCrmChange(trx, input.organizationId, 'crm_account', input.accountId, 1, 'updated')
    return { ok: true, contact: mapContact(row) }
  })
}

export async function listAccountContacts(
  db: Kysely<Database>,
  organizationId: string,
  accountId: string
): Promise<AccountContactResource[]> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const rows = await trx
      .selectFrom('crm.account_contacts')
      .selectAll()
      .where('account_id', '=', accountId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    return rows.map(mapContact)
  })
}

export type CreateOpportunityResult =
  | { ok: true; opportunity: OpportunityResource }
  | { ok: false; reason: 'account_not_found' }

export async function createOpportunity(
  db: Kysely<Database>,
  input: {
    organizationId: string
    actorUserId: string
    accountId: string
    name: string
    amount?: number | string
    probability?: number | null
    ownerUserId?: string | null
    expectedCloseAt?: string | null
  }
): Promise<CreateOpportunityResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const account = await trx
      .selectFrom('crm.accounts')
      .select('id')
      .where('id', '=', input.accountId)
      .executeTakeFirst()
    if (!account) {
      return { ok: false, reason: 'account_not_found' }
    }
    const row = await trx
      .insertInto('crm.opportunities')
      .values({
        organization_id: input.organizationId,
        account_id: input.accountId,
        name: input.name,
        amount: input.amount ?? 0,
        probability: input.probability ?? null,
        owner_user_id: input.ownerUserId ?? null,
        expected_close_at: input.expectedCloseAt ?? null
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      'crm.opportunity.created',
      'crm_opportunity',
      row.id
    )
    await emitCrmChange(trx, input.organizationId, 'crm_opportunity', row.id, 1, 'created')
    return { ok: true, opportunity: mapOpportunity(row) }
  })
}

export async function getOpportunity(
  db: Kysely<Database>,
  organizationId: string,
  opportunityId: string
): Promise<OpportunityResource | null> {
  return withTenantTransaction(db, organizationId, async (trx) => {
    const row = await trx
      .selectFrom('crm.opportunities')
      .selectAll()
      .where('id', '=', opportunityId)
      .executeTakeFirst()
    return row ? mapOpportunity(row) : null
  })
}

export type TransitionOpportunityResult =
  | { ok: true; opportunity: OpportunityResource }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number }
  | { ok: false; reason: 'illegal_transition'; from: OpportunityStage }

/**
 * Advances an opportunity's pipeline stage under OCC (expectedVersion from If-Match). An illegal
 * jump or a stale version is a typed reject. Bumps version, audits, emits crm_opportunity updated.
 */
export async function transitionOpportunity(
  db: Kysely<Database>,
  input: {
    organizationId: string
    opportunityId: string
    actorUserId: string
    toStage: OpportunityStage
    expectedVersion: number
  }
): Promise<TransitionOpportunityResult> {
  return withTenantTransaction(db, input.organizationId, async (trx) => {
    const current = await trx
      .selectFrom('crm.opportunities')
      .selectAll()
      .where('id', '=', input.opportunityId)
      .forUpdate()
      .executeTakeFirst()
    if (!current) {
      return { ok: false, reason: 'not_found' }
    }
    const currentVersion = Number(current.version)
    if (currentVersion !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion }
    }
    const from = current.stage as OpportunityStage
    if (!isLegalOpportunityTransition(from, input.toStage)) {
      return { ok: false, reason: 'illegal_transition', from }
    }
    const newVersion = currentVersion + 1
    const updated = await trx
      .updateTable('crm.opportunities')
      .set({ stage: input.toStage, version: newVersion, updated_at: sql`now()` })
      .where('id', '=', input.opportunityId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit(
      trx,
      input.organizationId,
      input.actorUserId,
      `crm.opportunity.stage.${input.toStage}`,
      'crm_opportunity',
      input.opportunityId
    )
    await emitCrmChange(
      trx,
      input.organizationId,
      'crm_opportunity',
      input.opportunityId,
      newVersion,
      'updated'
    )
    return { ok: true, opportunity: mapOpportunity(updated) }
  })
}
