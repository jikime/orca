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
    launchId: randomUUID(),
    agentSessionId: o.agentSessionId,
    provider: 'claude_code',
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
  org = orgId
): Promise<Response> {
  const body: Record<string, unknown> = {
    batchId: randomUUID(),
    producerId: randomUUID(),
    protocolVersion: '1.0',
    events,
    clientCheckpoint: { streamId, lastServerAck: 0 }
  }
  if (executionContext) {
    body.executionContext = executionContext
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
        'binding_workspace_path'
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
  })

  it('(c) EXIT CONDITION: native vs ssh at the SAME workspacePath → two DISTINCT bindings, never merged (doc 14 :834)', async (ctx) => {
    if (!harness) {
      return ctx.skip()
    }
    const kp = makeKeypair()
    expect((await registerKey('owner', kp)).status).toBe(201)
    const sharedPath = '/repos/acme/service'
    const nativeHost = randomUUID()
    const sshHost = randomUUID()
    const sessionNative = await createSession('owner')
    const sessionSsh = await createSession('owner')
    const streamN = randomUUID()
    const streamS = randomUUID()
    // Same filesystem path, different host TYPE and host ID → two separate signed bindings.
    const nativeCtx = signContext(kp, {
      installationId: kp.installationId,
      agentSessionId: sessionNative.id,
      hostType: 'native',
      hostId: nativeHost,
      workspacePath: sharedPath
    })
    const sshCtx = signContext(kp, {
      installationId: kp.installationId,
      agentSessionId: sessionSsh.id,
      hostType: 'ssh',
      hostId: sshHost,
      workspacePath: sharedPath
    })
    expect(
      (
        await ingest(
          'owner',
          [envelope({ sessionId: sessionNative.id, streamId: streamN, sequence: 1 })],
          streamN,
          nativeCtx
        )
      ).status
    ).toBe(200)
    expect(
      (
        await ingest(
          'owner',
          [envelope({ sessionId: sessionSsh.id, streamId: streamS, sequence: 1 })],
          streamS,
          sshCtx
        )
      ).status
    ).toBe(200)
    const nb = await readBinding(sessionNative.id)
    const sb = await readBinding(sessionSsh.id)
    // Distinct host bindings recorded; neither session was merged into or overwritten by the other.
    expect(nb.binding_host_type).toBe('native')
    expect(nb.binding_host_id).toBe(nativeHost)
    expect(sb.binding_host_type).toBe('ssh')
    expect(sb.binding_host_id).toBe(sshHost)
    expect(nb.binding_workspace_path).toBe(sharedPath)
    expect(sb.binding_workspace_path).toBe(sharedPath)
    expect(sessionNative.id).not.toBe(sessionSsh.id)
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
})
