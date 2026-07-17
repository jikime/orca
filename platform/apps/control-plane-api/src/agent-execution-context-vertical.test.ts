import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  canonicalizeExecutionContext,
  createDatabase,
  createDatabasePool,
  runMigrations,
  seedEntitlementManifest,
  seedMembershipFixture,
  seedOrganizationFixture,
  seedRoleManifest,
  withTenantTransaction,
  type ExecutionContext,
  type ExecutionContextHostType,
  type PieDatabase,
  type SignedExecutionContext
} from '@pie/persistence'
import { startPostgresHarness, type PostgresHarness } from '@pie/persistence/testing'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import {
  createContractSchemaRegistry,
  type ContractSchemaRegistry
} from './contract-schema-registry'
import { createTestTokenVerifier, TEST_ISSUER } from './authorization-test-support'

// R5 slice 2b: the SIGNED ExecutionContext + SessionBinding vertical. Proves the exit condition
// (doc 14 :834 — a native vs WSL vs SSH launch at the SAME path is never misattributed) and the
// anti-forgery guards (doc 24). Signs contexts with the SAME canonical bytes the client signer uses
// (imported from @pie/persistence), so client/server canonical agreement is exercised end-to-end.

let harness: PostgresHarness | null = null
let pool: Pool
let db: PieDatabase
let registry: ContractSchemaRegistry
let app: FastifyInstance
let baseUrl = ''
let orgId = ''
let otherOrgId = ''

function bearerFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers
    }
  })
}

async function jsonOf<T>(r: Response): Promise<T> {
  return (await r.json()) as T
}

async function createSession(token: string, org = orgId): Promise<{ id: string }> {
  const res = await bearerFetch(token, `/v1/organizations/${org}/agent-sessions`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({ provider: 'claude_code', hostId: randomUUID() })
  })
  expect(res.status).toBe(201)
  return jsonOf<{ id: string }>(res)
}

function publicKeyId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ format: 'der', type: 'spki' })
  return createHash('sha256').update(der).digest('base64url')
}

type Keypair = { installationId: string; publicKeyPem: string; privateKey: KeyObject }

function makeKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    installationId: randomUUID(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    privateKey
  }
}

async function registerKey(token: string, kp: Keypair, org = orgId): Promise<Response> {
  return bearerFetch(token, `/v1/organizations/${org}/installation-keys`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify({
      installationId: kp.installationId,
      publicKey: kp.publicKeyPem,
      algorithm: 'ed25519'
    })
  })
}

type ContextOverrides = {
  installationId: string
  agentSessionId: string
  hostType?: ExecutionContextHostType
  hostId?: string
  workspacePath?: string
  osUser?: string
  provider?: string
  notBefore?: number
  notAfter?: number
}

// Signs a context with `signWith` (default: the same key), so a forged signature = a different key.
function signContext(
  kp: Keypair,
  o: ContextOverrides,
  signWith?: KeyObject
): SignedExecutionContext {
  const now = Date.now()
  const context: ExecutionContext = {
    schemaVersion: 1,
    installationId: o.installationId,
    hostType: o.hostType ?? 'native',
    hostId: o.hostId ?? randomUUID(),
    workspacePath: o.workspacePath ?? '/Users/dev/projects/orca',
    osUser: o.osUser ?? 'dev',
    launchId: randomUUID(),
    agentSessionId: o.agentSessionId,
    provider: o.provider ?? 'claude_code',
    notBefore: o.notBefore ?? now - 60_000,
    notAfter: o.notAfter ?? now + 300_000
  }
  const signature = sign(
    null,
    Buffer.from(canonicalizeExecutionContext(context), 'utf-8'),
    signWith ?? kp.privateKey
  )
  return {
    context,
    installationId: o.installationId,
    signature: signature.toString('base64'),
    publicKeyId: publicKeyId(kp.publicKeyPem)
  }
}

function envelope(o: {
  sessionId: string
  streamId: string
  sequence: number
  pieorgid?: string
}): Record<string, unknown> {
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: 'urn:pie:client:installation',
    type: 'ai.pielab.agent.turn.streamed.v1',
    subject: 'agent-run',
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    dataschema: 'https://schemas.pielab.ai/events/agent-event-envelope.v1.schema.json',
    pieorgid: o.pieorgid ?? orgId,
    piestream: o.streamId,
    piesequence: o.sequence,
    data: {
      context: {
        projectId: null,
        workItemId: null,
        workspaceId: null,
        hostId: randomUUID(),
        launchId: null,
        agentSessionId: o.sessionId,
        agentRunId: null,
        turnId: null
      },
      producer: {
        type: 'hook',
        provider: 'claude_code',
        parserVersion: '1.0.0',
        trustDomain: 'client_observed'
      },
      assertion: 'observed',
      classification: 'internal',
      visibility: 'internal',
      payload: { note: 'streamed' },
      capturedAt: new Date().toISOString()
    }
  }
}

function ingest(
  token: string,
  events: Record<string, unknown>[],
  streamId: string,
  executionContext?: SignedExecutionContext,
  org = orgId,
  opts: { submissionNonce?: string; batchId?: string } = {}
): Promise<Response> {
  const body: Record<string, unknown> = {
    batchId: opts.batchId ?? randomUUID(),
    producerId: randomUUID(),
    protocolVersion: '1.0',
    events,
    clientCheckpoint: { streamId, lastServerAck: 0 }
  }
  if (executionContext) {
    body.executionContext = executionContext
  }
  if (opts.submissionNonce !== undefined) {
    body.submissionNonce = opts.submissionNonce
  }
  return bearerFetch(token, `/v1/organizations/${org}/agent-events:batch`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: JSON.stringify(body)
  })
}

type SessionBinding = {
  binding_trust_domain: string
  binding_installation_id: string | null
  binding_host_type: string | null
  binding_host_id: string | null
  binding_workspace_path: string | null
  binding_os_user: string | null
  binding_provider: string | null
}

async function readBinding(sessionId: string): Promise<SessionBinding> {
  return withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('execution.agent_sessions')
      .select([
        'binding_trust_domain',
        'binding_installation_id',
        'binding_host_type',
        'binding_host_id',
        'binding_workspace_path',
        'binding_os_user',
        'binding_provider'
      ])
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow()
  )
}

async function countRejectAudits(): Promise<number> {
  const row = await withTenantTransaction(db, orgId, (trx) =>
    trx
      .selectFrom('audit.audit_events')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .where('action', '=', 'execution_context.rejected')
      .executeTakeFirstOrThrow()
  )
  return Number(row.c)
}

async function countRejectAuditsByDigest(digest: string, org = orgId): Promise<number> {
  const row = await withTenantTransaction(db, org, (trx) =>
    trx
      .selectFrom('audit.audit_events')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .where('action', '=', 'execution_context.rejected')
      .where('after_digest', '=', digest)
      .executeTakeFirstOrThrow()
  )
  return Number(row.c)
}

async function countSessionEvents(sessionId: string, org = orgId): Promise<number> {
  const row = await withTenantTransaction(db, org, (trx) =>
    trx
      .selectFrom('execution.agent_events')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .where('agent_session_id', '=', sessionId)
      .executeTakeFirstOrThrow()
  )
  return Number(row.c)
}

beforeAll(async () => {
  try {
    harness = await startPostgresHarness()
  } catch (error) {
    console.warn(
      `SKIPPED execution-context binding vertical: Docker unavailable — ${String(error)}`
    )
    return
  }
  pool = createDatabasePool({ connectionString: harness.connectionString })
  db = createDatabase(pool)
  await runMigrations(pool)
  await seedRoleManifest(db)
  await seedEntitlementManifest(db)
  registry = createContractSchemaRegistry()
  app = buildApp({ ping: async () => true, db, registry, tokenVerifier: createTestTokenVerifier() })
  await app.ready()
  await app.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  orgId = randomUUID()
  otherOrgId = randomUUID()
  await seedOrganizationFixture(db, {
    id: orgId,
    slug: `ai-${orgId.slice(0, 8)}`,
    displayName: 'AI'
  })
  await seedOrganizationFixture(db, {
    id: otherOrgId,
    slug: `other-${otherOrgId.slice(0, 8)}`,
    displayName: 'Other'
  })
  await seedMembershipFixture(db, {
    organizationId: orgId,
    issuer: TEST_ISSUER,
    subject: 'owner',
    roleIds: ['organization_owner']
  })
  await seedMembershipFixture(db, {
    organizationId: otherOrgId,
    issuer: TEST_ISSUER,
    subject: 'otherowner',
    roleIds: ['organization_owner']
  })
}, 180_000)

afterAll(async () => {
  await app?.close()
  await db?.destroy()
  await harness?.stop()
})

describe('signed execution context + session binding vertical (R5 s2b)', () => {
  it('(a) registers an installation key; re-register rotates and is audited', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const kp = makeKeypair()
    const first = await registerKey('owner', kp)
    expect(first.status).toBe(201)
    const firstBody = await jsonOf<{ id: string; rotated: boolean; publicKeyId: string }>(first)
    expect(firstBody.rotated).toBe(false)
    expect(firstBody.publicKeyId).toBe(publicKeyId(kp.publicKeyPem))
    // Re-register the SAME installation with a NEW key → rotation.
    const rotatedKp: Keypair = { ...makeKeypair(), installationId: kp.installationId }
    const second = await registerKey('owner', rotatedKp)
    const secondBody = await jsonOf<{ rotated: boolean }>(second)
    expect(secondBody.rotated).toBe(true)
    const audits = await withTenantTransaction(db, orgId, (trx) =>
      trx
        .selectFrom('audit.audit_events')
        .select('id')
        .where('action', '=', 'installation_key.registered')
        .execute()
    )
    expect(audits.length).toBeGreaterThanOrEqual(2)
  })

  it('(b) a VALID signed context is accepted and binds the session installation_signed', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const kp = makeKeypair()
    expect((await registerKey('owner', kp)).status).toBe(201)
    const session = await createSession('owner')
    const streamId = randomUUID()
    const signed = signContext(kp, {
      installationId: kp.installationId,
      agentSessionId: session.id,
      hostType: 'native',
      workspacePath: '/Users/dev/projects/orca'
    })
    const res = await ingest(
      'owner',
      [envelope({ sessionId: session.id, streamId, sequence: 1 })],
      streamId,
      signed
    )
    expect(res.status).toBe(200)
    const binding = await readBinding(session.id)
    expect(binding.binding_trust_domain).toBe('installation_signed')
    expect(binding.binding_host_type).toBe('native')
    expect(binding.binding_installation_id).toBe(kp.installationId)
    expect(binding.binding_workspace_path).toBe('/Users/dev/projects/orca')
    // IDN-008 + BND-002: the binding row persists the OS user and the provider.
    expect(binding.binding_os_user).toBe('dev')
    expect(binding.binding_provider).toBe('claude_code')
  })

  it('(c) EXIT CONDITION: native vs WSL vs SSH at the SAME workspacePath → three DISTINCT bindings, never merged (doc 14 :834)', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const kp = makeKeypair()
    expect((await registerKey('owner', kp)).status).toBe(201)
    const sharedPath = '/repos/acme/service'
    // Same filesystem path across all three host TYPES + distinct host IDs → three separate bindings.
    const hosts: { type: ExecutionContextHostType; hostId: string; session: { id: string } }[] = [
      { type: 'native', hostId: randomUUID(), session: await createSession('owner') },
      { type: 'wsl', hostId: randomUUID(), session: await createSession('owner') },
      { type: 'ssh', hostId: randomUUID(), session: await createSession('owner') }
    ]
    for (const host of hosts) {
      const streamId = randomUUID()
      const signed = signContext(kp, {
        installationId: kp.installationId,
        agentSessionId: host.session.id,
        hostType: host.type,
        hostId: host.hostId,
        workspacePath: sharedPath
      })
      expect(
        (
          await ingest(
            'owner',
            [envelope({ sessionId: host.session.id, streamId, sequence: 1 })],
            streamId,
            signed
          )
        ).status
      ).toBe(200)
    }
    // Each session keeps its own host binding; none was merged into or overwritten by another.
    for (const host of hosts) {
      const binding = await readBinding(host.session.id)
      expect(binding.binding_host_type).toBe(host.type)
      expect(binding.binding_host_id).toBe(host.hostId)
      expect(binding.binding_workspace_path).toBe(sharedPath)
    }
    const sessionIds = new Set(hosts.map((host) => host.session.id))
    expect(sessionIds.size).toBe(3)
  })

  it('(d) an EXPIRED context is rejected 422 CONTEXT_EXPIRED + audited', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const before = await countRejectAudits()
    const kp = makeKeypair()
    expect((await registerKey('owner', kp)).status).toBe(201)
    const session = await createSession('owner')
    const streamId = randomUUID()
    const expired = signContext(kp, {
      installationId: kp.installationId,
      agentSessionId: session.id,
      notBefore: Date.now() - 120_000,
      notAfter: Date.now() - 60_000
    })
    const res = await ingest(
      'owner',
      [envelope({ sessionId: session.id, streamId, sequence: 1 })],
      streamId,
      expired
    )
    expect(res.status).toBe(422)
    expect((await jsonOf<{ code: string }>(res)).code).toBe('CONTEXT_EXPIRED')
    expect(await countRejectAudits()).toBeGreaterThan(before)
    // No events ingested under a rejected context.
    const binding = await readBinding(session.id)
    expect(binding.binding_trust_domain).toBe('local_observed')
  })

  it('(e) a FORGED signature (wrong key) is rejected 422 SIGNATURE_INVALID', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const kp = makeKeypair()
    expect((await registerKey('owner', kp)).status).toBe(201)
    const session = await createSession('owner')
    const streamId = randomUUID()
    // Sign with a DIFFERENT private key than the one registered for this installation.
    const attacker = generateKeyPairSync('ed25519').privateKey
    const forged = signContext(
      kp,
      { installationId: kp.installationId, agentSessionId: session.id },
      attacker
    )
    const res = await ingest(
      'owner',
      [envelope({ sessionId: session.id, streamId, sequence: 1 })],
      streamId,
      forged
    )
    expect(res.status).toBe(422)
    expect((await jsonOf<{ code: string }>(res)).code).toBe('SIGNATURE_INVALID')
  })

  it('(f) a context whose agentSessionId ≠ the events is rejected 422 CONTEXT_SESSION_MISMATCH', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const kp = makeKeypair()
    expect((await registerKey('owner', kp)).status).toBe(201)
    const session = await createSession('owner')
    const streamId = randomUUID()
    // Context binds a DIFFERENT session than the event references.
    const signed = signContext(kp, {
      installationId: kp.installationId,
      agentSessionId: randomUUID()
    })
    const res = await ingest(
      'owner',
      [envelope({ sessionId: session.id, streamId, sequence: 1 })],
      streamId,
      signed
    )
    expect(res.status).toBe(422)
    expect((await jsonOf<{ code: string }>(res)).code).toBe('CONTEXT_SESSION_MISMATCH')
  })

  it('(g) BINDING_HOST_MISMATCH: re-binding ONE session to a different host is rejected 422', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const kp = makeKeypair()
    expect((await registerKey('owner', kp)).status).toBe(201)
    const session = await createSession('owner')
    const s1 = randomUUID()
    const first = signContext(kp, {
      installationId: kp.installationId,
      agentSessionId: session.id,
      hostType: 'native',
      hostId: randomUUID(),
      workspacePath: '/a/b'
    })
    expect(
      (
        await ingest(
          'owner',
          [envelope({ sessionId: session.id, streamId: s1, sequence: 1 })],
          s1,
          first
        )
      ).status
    ).toBe(200)
    // Re-bind the SAME session to a DIFFERENT host identity → refused.
    const s2 = randomUUID()
    const conflicting = signContext(kp, {
      installationId: kp.installationId,
      agentSessionId: session.id,
      hostType: 'ssh',
      hostId: randomUUID(),
      workspacePath: '/a/b'
    })
    const res = await ingest(
      'owner',
      [envelope({ sessionId: session.id, streamId: s2, sequence: 2 })],
      s2,
      conflicting
    )
    expect(res.status).toBe(422)
    expect((await jsonOf<{ code: string }>(res)).code).toBe('BINDING_HOST_MISMATCH')
  })

  it('(h) cross-tenant key isolation: org B cannot verify against org A key → 422 KEY_NOT_REGISTERED', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    // Register the key in org A only.
    const kp = makeKeypair()
    expect((await registerKey('owner', kp)).status).toBe(201)
    // A session + valid-shaped context in org B, signed by the same key, but the key is unknown there.
    const sessionB = await createSession('otherowner', otherOrgId)
    const streamId = randomUUID()
    const signed = signContext(kp, {
      installationId: kp.installationId,
      agentSessionId: sessionB.id
    })
    const res = await ingest(
      'otherowner',
      [envelope({ sessionId: sessionB.id, streamId, sequence: 1, pieorgid: otherOrgId })],
      streamId,
      signed,
      otherOrgId
    )
    expect(res.status).toBe(422)
    expect((await jsonOf<{ code: string }>(res)).code).toBe('KEY_NOT_REGISTERED')
  })

  it('(i) back-compat: a batch with NO signed context still ingests at local_observed', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const session = await createSession('owner')
    const streamId = randomUUID()
    const res = await ingest(
      'owner',
      [envelope({ sessionId: session.id, streamId, sequence: 1 })],
      streamId
    )
    expect(res.status).toBe(200)
    const binding = await readBinding(session.id)
    expect(binding.binding_trust_domain).toBe('local_observed')
    expect(binding.binding_installation_id).toBeNull()
  })

  it('(j) a NOT-YET-VALID context (notBefore in the future) is rejected 422 CONTEXT_NOT_YET_VALID + audited', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const before = await countRejectAuditsByDigest('CONTEXT_NOT_YET_VALID')
    const kp = makeKeypair()
    expect((await registerKey('owner', kp)).status).toBe(201)
    const session = await createSession('owner')
    const streamId = randomUUID()
    const premature = signContext(kp, {
      installationId: kp.installationId,
      agentSessionId: session.id,
      notBefore: Date.now() + 120_000,
      notAfter: Date.now() + 300_000
    })
    const res = await ingest(
      'owner',
      [envelope({ sessionId: session.id, streamId, sequence: 1 })],
      streamId,
      premature
    )
    expect(res.status).toBe(422)
    expect((await jsonOf<{ code: string }>(res)).code).toBe('CONTEXT_NOT_YET_VALID')
    expect(await countRejectAuditsByDigest('CONTEXT_NOT_YET_VALID')).toBeGreaterThan(before)
    // No binding, no events under a not-yet-valid context.
    expect((await readBinding(session.id)).binding_trust_domain).toBe('local_observed')
    expect(await countSessionEvents(session.id)).toBe(0)
  })

  it('(k) SUBMISSION_REPLAYED: a consumed (installation, nonce) reused under a DIFFERENT batchId is rejected 422 + audited, its events NOT ingested', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const before = await countRejectAuditsByDigest('SUBMISSION_REPLAYED')
    const kp = makeKeypair()
    expect((await registerKey('owner', kp)).status).toBe(201)
    const session = await createSession('owner')
    const streamId = randomUUID()
    const signed = signContext(kp, {
      installationId: kp.installationId,
      agentSessionId: session.id
    })
    const nonce = randomUUID()
    // First submission consumes the nonce and ingests one event.
    const first = await ingest(
      'owner',
      [envelope({ sessionId: session.id, streamId, sequence: 1 })],
      streamId,
      signed,
      orgId,
      { submissionNonce: nonce, batchId: randomUUID() }
    )
    expect(first.status).toBe(200)
    expect(await countSessionEvents(session.id)).toBe(1)
    // A DIFFERENT batch (new batchId + new event) reusing the SAME consumed nonce → replay.
    const replay = await ingest(
      'owner',
      [envelope({ sessionId: session.id, streamId, sequence: 2 })],
      streamId,
      signed,
      orgId,
      { submissionNonce: nonce, batchId: randomUUID() }
    )
    expect(replay.status).toBe(422)
    expect((await jsonOf<{ code: string }>(replay)).code).toBe('SUBMISSION_REPLAYED')
    expect(await countRejectAuditsByDigest('SUBMISSION_REPLAYED')).toBeGreaterThan(before)
    // The replay's event was NOT ingested (still just the first event).
    expect(await countSessionEvents(session.id)).toBe(1)
  })

  it('(l) multi-batch reuse: the SAME context across TWO batches with FRESH nonces is accepted (per-launch credential still reusable)', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const kp = makeKeypair()
    expect((await registerKey('owner', kp)).status).toBe(201)
    const session = await createSession('owner')
    const streamId = randomUUID()
    const signed = signContext(kp, {
      installationId: kp.installationId,
      agentSessionId: session.id
    })
    const b1 = await ingest(
      'owner',
      [envelope({ sessionId: session.id, streamId, sequence: 1 })],
      streamId,
      signed,
      orgId,
      { submissionNonce: randomUUID(), batchId: randomUUID() }
    )
    const b2 = await ingest(
      'owner',
      [envelope({ sessionId: session.id, streamId, sequence: 2 })],
      streamId,
      signed,
      orgId,
      { submissionNonce: randomUUID(), batchId: randomUUID() }
    )
    expect(b1.status).toBe(200)
    expect(b2.status).toBe(200)
    // Both batches ingested — the signed context is reusable across batches, only the nonce is one-time.
    expect(await countSessionEvents(session.id)).toBe(2)
  })

  it('(m) the SAME batchId + SAME nonce (idempotent retry) is NOT treated as a replay', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const kp = makeKeypair()
    expect((await registerKey('owner', kp)).status).toBe(201)
    const session = await createSession('owner')
    const streamId = randomUUID()
    const signed = signContext(kp, {
      installationId: kp.installationId,
      agentSessionId: session.id
    })
    const nonce = randomUUID()
    const batchId = randomUUID()
    const evt = envelope({ sessionId: session.id, streamId, sequence: 1 })
    const first = await ingest('owner', [evt], streamId, signed, orgId, {
      submissionNonce: nonce,
      batchId
    })
    // A byte-identical retry of the SAME batch (same batchId, same nonce, same event) → idempotent.
    const retry = await ingest('owner', [evt], streamId, signed, orgId, {
      submissionNonce: nonce,
      batchId
    })
    expect(first.status).toBe(200)
    expect(retry.status).toBe(200)
    // The event is stored once (event idempotency), never duplicated by the retry.
    expect(await countSessionEvents(session.id)).toBe(1)
  })

  it('(n) cross-tenant nonce isolation: the SAME nonce value in org B does not collide with org A', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const sharedNonce = randomUUID()
    const kpA = makeKeypair()
    expect((await registerKey('owner', kpA)).status).toBe(201)
    const sessionA = await createSession('owner')
    const streamA = randomUUID()
    const signedA = signContext(kpA, {
      installationId: kpA.installationId,
      agentSessionId: sessionA.id
    })
    expect(
      (
        await ingest(
          'owner',
          [envelope({ sessionId: sessionA.id, streamId: streamA, sequence: 1 })],
          streamA,
          signedA,
          orgId,
          { submissionNonce: sharedNonce, batchId: randomUUID() }
        )
      ).status
    ).toBe(200)
    // Org B consumes the SAME nonce value — RLS isolates the table, so it is fresh here, not a replay.
    const kpB: Keypair = { ...makeKeypair(), installationId: kpA.installationId }
    expect((await registerKey('otherowner', kpB, otherOrgId)).status).toBe(201)
    const sessionB = await createSession('otherowner', otherOrgId)
    const streamB = randomUUID()
    const signedB = signContext(kpB, {
      installationId: kpB.installationId,
      agentSessionId: sessionB.id
    })
    const resB = await ingest(
      'otherowner',
      [envelope({ sessionId: sessionB.id, streamId: streamB, sequence: 1, pieorgid: otherOrgId })],
      streamB,
      signedB,
      otherOrgId,
      { submissionNonce: sharedNonce, batchId: randomUUID() }
    )
    expect(resB.status).toBe(200)
    expect(await countSessionEvents(sessionB.id, otherOrgId)).toBe(1)
  })

  it('(o) IDN-008: two OS users on the SAME host+path → two DISTINCT bindings; re-bind one to a different osUser → BINDING_HOST_MISMATCH', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const kp = makeKeypair()
    expect((await registerKey('owner', kp)).status).toBe(201)
    const sharedHostId = randomUUID()
    const sharedPath = '/srv/build/repo'
    // Same installation + host TYPE + host ID + path, differing ONLY in osUser → two sessions bind
    // distinctly (the shared-host gap: without osUser these would produce an identical binding).
    const users: { osUser: string; session: { id: string } }[] = [
      { osUser: 'alice', session: await createSession('owner') },
      { osUser: 'bob', session: await createSession('owner') }
    ]
    for (const u of users) {
      const streamId = randomUUID()
      const signed = signContext(kp, {
        installationId: kp.installationId,
        agentSessionId: u.session.id,
        hostType: 'native',
        hostId: sharedHostId,
        workspacePath: sharedPath,
        osUser: u.osUser
      })
      expect(
        (
          await ingest(
            'owner',
            [envelope({ sessionId: u.session.id, streamId, sequence: 1 })],
            streamId,
            signed
          )
        ).status
      ).toBe(200)
    }
    for (const u of users) {
      const binding = await readBinding(u.session.id)
      expect(binding.binding_os_user).toBe(u.osUser)
      expect(binding.binding_host_id).toBe(sharedHostId)
      expect(binding.binding_workspace_path).toBe(sharedPath)
    }
    // Re-bind alice's session to a DIFFERENT osUser at the same host+path → refused.
    const s2 = randomUUID()
    const conflicting = signContext(kp, {
      installationId: kp.installationId,
      agentSessionId: users[0].session.id,
      hostType: 'native',
      hostId: sharedHostId,
      workspacePath: sharedPath,
      osUser: 'mallory'
    })
    const res = await ingest(
      'owner',
      [envelope({ sessionId: users[0].session.id, streamId: s2, sequence: 2 })],
      s2,
      conflicting
    )
    expect(res.status).toBe(422)
    expect((await jsonOf<{ code: string }>(res)).code).toBe('BINDING_HOST_MISMATCH')
  })

  it('(p) BND-002: same session-string under DIFFERENT providers → distinct bindings; re-bind to a different provider → BINDING_HOST_MISMATCH', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const kp = makeKeypair()
    expect((await registerKey('owner', kp)).status).toBe(201)
    const sharedHostId = randomUUID()
    const sharedPath = '/repos/acme/api'
    // Two launches with the SAME provider-session-string but DIFFERENT providers must not collide.
    const providers: { provider: string; session: { id: string } }[] = [
      { provider: 'claude_code', session: await createSession('owner') },
      { provider: 'codex', session: await createSession('owner') }
    ]
    for (const p of providers) {
      const streamId = randomUUID()
      const signed = signContext(kp, {
        installationId: kp.installationId,
        agentSessionId: p.session.id,
        hostType: 'native',
        hostId: sharedHostId,
        workspacePath: sharedPath,
        provider: p.provider
      })
      expect(
        (
          await ingest(
            'owner',
            [envelope({ sessionId: p.session.id, streamId, sequence: 1 })],
            streamId,
            signed
          )
        ).status
      ).toBe(200)
    }
    for (const p of providers) {
      const binding = await readBinding(p.session.id)
      expect(binding.binding_provider).toBe(p.provider)
    }
    // Re-bind the first session to a DIFFERENT provider → refused.
    const s2 = randomUUID()
    const conflicting = signContext(kp, {
      installationId: kp.installationId,
      agentSessionId: providers[0].session.id,
      hostType: 'native',
      hostId: sharedHostId,
      workspacePath: sharedPath,
      provider: 'gemini'
    })
    const res = await ingest(
      'owner',
      [envelope({ sessionId: providers[0].session.id, streamId: s2, sequence: 2 })],
      s2,
      conflicting
    )
    expect(res.status).toBe(422)
    expect((await jsonOf<{ code: string }>(res)).code).toBe('BINDING_HOST_MISMATCH')
  })
})
