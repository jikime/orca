import path from 'node:path'

import {
  invariant,
  listFiles,
  manifestDirectory,
  readJson,
  readText,
  schemaDirectory,
  threatModelPath
} from './contract-file-io.mjs'

const expectedManifestNames = new Set([
  'capabilities.json',
  'entitlements.json',
  'error-codes.json',
  'kroot-capability-migration.json',
  'mcp-tools.json',
  'permissions.json',
  'protocol-support.json',
  'roles.json',
  'security-gates.json',
  'source-baselines.json',
  'support-matrix.json'
])
const stagePattern = /^R[1-9]$/
const migrationStagePattern = /^R[1-9]\+?$/
const migrationDecisions = new Set([
  'adopt',
  'adopt_defer',
  'defer',
  'discard_and_rebuild',
  'evaluate_separately',
  'harden_reimplement',
  'information_architecture_only',
  'reimplement',
  'replace',
  'replace_with_orca',
  'selective',
  'ux_reference_only'
])

function readManifest(name) {
  const document = readJson(path.join(manifestDirectory, name))
  invariant(document.schemaVersion === 1, `${name} must use schemaVersion 1`)
  return document
}

function uniqueValues(items, select, label) {
  const values = items.map(select)
  invariant(
    values.every((value) => typeof value === 'string' && value.length > 0),
    `${label} must be non-empty strings`
  )
  invariant(new Set(values).size === values.length, `Duplicate ${label}`)
  return new Set(values)
}

function verifyManifestCoverage() {
  const actualNames = listFiles(manifestDirectory, '.json').map((filePath) =>
    path.basename(filePath)
  )
  invariant(
    actualNames.length === expectedManifestNames.size,
    'Manifest verification coverage is incomplete'
  )
  for (const name of actualNames) {
    invariant(expectedManifestNames.has(name), `Manifest lacks verification: ${name}`)
  }
}

function verifyPermissionsAndRoles() {
  const permissions = readManifest('permissions.json').permissions
  invariant(Array.isArray(permissions) && permissions.length > 0, 'Permissions must not be empty')
  const permissionIds = uniqueValues(permissions, (permission) => permission.id, 'permission ID')
  for (const permission of permissions) {
    invariant(
      /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(permission.id),
      `Invalid permission ID: ${permission.id}`
    )
    invariant(
      typeof permission.resource === 'string' && permission.resource.length > 0,
      `Permission lacks resource: ${permission.id}`
    )
    invariant(
      typeof permission.action === 'string' && permission.action.length > 0,
      `Permission lacks action: ${permission.id}`
    )
    invariant(
      ['standard', 'elevated', 'critical'].includes(permission.risk),
      `Invalid permission risk: ${permission.id}`
    )
  }

  const rolesDocument = readManifest('roles.json')
  invariant(rolesDocument.defaultDeny === true, 'RBAC must remain default-deny')
  const roles = rolesDocument.roles
  uniqueValues(roles, (role) => role.id, 'role ID')
  for (const role of roles) {
    invariant(
      ['organization', 'project', 'resource'].includes(role.scope),
      `Invalid role scope: ${role.id}`
    )
    invariant(typeof role.external === 'boolean', `Role external flag is required: ${role.id}`)
    const rolePermissionIds = uniqueValues(
      role.permissions,
      (permissionId) => permissionId,
      `permission in role ${role.id}`
    )
    for (const permissionId of rolePermissionIds) {
      invariant(
        permissionIds.has(permissionId),
        `Role ${role.id} references unknown permission ${permissionId}`
      )
    }
  }
  return permissionIds
}

function verifyCapabilitiesAndEntitlements() {
  const capabilities = readManifest('capabilities.json').capabilities
  uniqueValues(capabilities, (capability) => capability.id, 'capability ID')
  for (const capability of capabilities) {
    invariant(
      typeof capability.requiredProfile === 'string' && capability.requiredProfile.length > 0,
      `Capability lacks profile: ${capability.id}`
    )
  }

  const document = readManifest('entitlements.json')
  const entitlements = document.entitlements
  const entitlementIds = uniqueValues(
    entitlements,
    (entitlement) => entitlement.id,
    'entitlement ID'
  )
  const enforcementById = new Map()
  for (const entitlement of entitlements) {
    invariant(
      ['boolean', 'limit'].includes(entitlement.enforcement),
      `Invalid entitlement enforcement: ${entitlement.id}`
    )
    invariant(
      typeof entitlement.unit === 'string' && entitlement.unit.length > 0,
      `Entitlement lacks unit: ${entitlement.id}`
    )
    enforcementById.set(entitlement.id, entitlement.enforcement)
  }

  uniqueValues(document.plans, (plan) => plan.id, 'plan ID')
  for (const plan of document.plans) {
    invariant(
      Array.isArray(plan.deploymentTypes) && plan.deploymentTypes.length > 0,
      `Plan lacks deployment types: ${plan.id}`
    )
    invariant(
      new Set(plan.deploymentTypes).size === plan.deploymentTypes.length,
      `Duplicate deployment type in plan ${plan.id}`
    )
    invariant(
      Object.keys(plan.grants).length === entitlementIds.size,
      `Plan ${plan.id} must grant every entitlement explicitly`
    )
    for (const [entitlementId, grant] of Object.entries(plan.grants)) {
      invariant(
        entitlementIds.has(entitlementId),
        `Plan ${plan.id} references unknown entitlement ${entitlementId}`
      )
      const validGrant =
        enforcementById.get(entitlementId) === 'boolean'
          ? typeof grant === 'boolean'
          : grant === null || (Number.isInteger(grant) && grant >= 0)
      invariant(validGrant, `Invalid ${entitlementId} grant in plan ${plan.id}`)
    }
  }
}

function verifyErrorsAndProtocols() {
  const errors = readManifest('error-codes.json').errors
  uniqueValues(errors, (error) => error.code, 'error code')
  for (const error of errors) {
    invariant(/^[A-Z][A-Z0-9_]*$/.test(error.code), `Invalid error code: ${error.code}`)
    invariant(
      Number.isInteger(error.status) && error.status >= 400 && error.status <= 599,
      `Invalid status for ${error.code}`
    )
    invariant(
      typeof error.retryable === 'boolean',
      `Error retryable flag is required: ${error.code}`
    )
  }

  const document = readManifest('protocol-support.json')
  const expectedProtocols = [
    'discovery',
    'api',
    'realtime',
    'ipc',
    'runtime',
    'agentIngest',
    'relay',
    'mcp'
  ]
  invariant(
    Object.keys(document.protocols).length === expectedProtocols.length,
    'Protocol support set changed without verification'
  )
  for (const protocolName of expectedProtocols) {
    const protocol = document.protocols[protocolName]
    invariant(
      protocol && typeof protocol.current === 'string',
      `Missing protocol support: ${protocolName}`
    )
    invariant(
      Array.isArray(protocol.supported) && protocol.supported.includes(protocol.current),
      `Current ${protocolName} protocol is not supported`
    )
    invariant(
      new Set(protocol.supported).size === protocol.supported.length,
      `Duplicate ${protocolName} protocol version`
    )
  }
  invariant(
    /^\d+\.\d+\.\d+$/.test(document.minimumClientVersion),
    'Minimum client version must be SemVer'
  )
}

function loadSchemasById(schemaIds) {
  const schemasById = new Map()
  for (const filePath of listFiles(schemaDirectory, '.json')) {
    const schema = readJson(filePath)
    invariant(schemaIds.has(schema.$id), `Schema registry omitted ${schema.$id}`)
    schemasById.set(schema.$id, schema)
  }
  return schemasById
}

function verifyMcpTools(schemaIds, permissionIds) {
  const document = readManifest('mcp-tools.json')
  invariant(document.transport === 'stdio', 'R0 MCP transport must remain stdio')
  const tools = document.tools
  uniqueValues(tools, (tool) => tool.name, 'MCP tool name')
  const schemasById = loadSchemasById(schemaIds)
  for (const tool of tools) {
    invariant(/^pie\.[a-z][a-z0-9_.]*$/.test(tool.name), `Invalid MCP tool name: ${tool.name}`)
    invariant(
      schemasById.has(tool.inputSchemaId),
      `Unknown MCP input schema: ${tool.inputSchemaId}`
    )
    invariant(
      schemasById.has(tool.outputSchemaId),
      `Unknown MCP output schema: ${tool.outputSchemaId}`
    )
    invariant(
      Array.isArray(tool.requiredPermissions) && tool.requiredPermissions.length > 0,
      `MCP tool lacks permissions: ${tool.name}`
    )
    for (const permissionId of tool.requiredPermissions) {
      invariant(
        permissionIds.has(permissionId),
        `MCP tool ${tool.name} references unknown permission ${permissionId}`
      )
    }
    invariant(
      Number.isInteger(tool.maxOutputBytes) && tool.maxOutputBytes > 0,
      `MCP tool lacks an output bound: ${tool.name}`
    )

    const requiredFields = new Set(schemasById.get(tool.inputSchemaId).required ?? [])
    invariant(
      tool.sideEffect === tool.requiresIdempotencyKey,
      `MCP side-effect/idempotency mismatch: ${tool.name}`
    )
    invariant(
      tool.sideEffect === tool.requiresExpectedVersion,
      `MCP side-effect/version mismatch: ${tool.name}`
    )
    invariant(
      requiredFields.has('idempotencyKey') === tool.requiresIdempotencyKey,
      `MCP idempotency schema mismatch: ${tool.name}`
    )
    invariant(
      requiredFields.has('expectedVersion') === tool.requiresExpectedVersion,
      `MCP version schema mismatch: ${tool.name}`
    )
  }
  return tools.length
}

function verifySourcesAndMigration() {
  const baselines = readManifest('source-baselines.json')
  invariant(
    !Number.isNaN(Date.parse(baselines.capturedAt)),
    'Source baseline capture time is invalid'
  )
  const sourceIds = uniqueValues(baselines.sources, (source) => source.id, 'source ID')
  for (const source of baselines.sources) {
    invariant(
      typeof source.repository === 'string' && source.repository.length > 0,
      `Source lacks repository: ${source.id}`
    )
    invariant(/^[0-9a-f]{40}$/.test(source.commit), `Source lacks a full commit SHA: ${source.id}`)
  }

  const migration = readManifest('kroot-capability-migration.json')
  invariant(
    sourceIds.has(migration.sourceId),
    `Migration references unknown source: ${migration.sourceId}`
  )
  uniqueValues(migration.capabilities, (capability) => capability.id, 'migration capability ID')
  for (const capability of migration.capabilities) {
    invariant(
      Array.isArray(capability.source) && capability.source.length > 0,
      `Migration capability lacks source: ${capability.id}`
    )
    invariant(
      typeof capability.pieTarget === 'string' && capability.pieTarget.length > 0,
      `Migration capability lacks target: ${capability.id}`
    )
    invariant(
      migrationDecisions.has(capability.decision),
      `Invalid migration decision: ${capability.id}`
    )
    invariant(
      Array.isArray(capability.stages) &&
        capability.stages.every((stage) => migrationStagePattern.test(stage)),
      `Invalid migration stage: ${capability.id}`
    )
  }
}

function verifySecurityGates() {
  const document = readManifest('security-gates.json')
  invariant(
    document.threatModel === 'pie-docs/24-security-threat-model.md',
    'Security gate threat-model path changed'
  )
  const documentedThreatIds = new Set(readText(threatModelPath).match(/[A-Z]{3}-\d{3}/g) ?? [])
  const gateThreatIds = uniqueValues(
    document.gates,
    (gate) => gate.threatId,
    'security gate threat ID'
  )
  invariant(
    gateThreatIds.size === documentedThreatIds.size,
    'P0 threat gate coverage is incomplete'
  )
  for (const gate of document.gates) {
    invariant(
      documentedThreatIds.has(gate.threatId),
      `Security gate references unknown threat ${gate.threatId}`
    )
    invariant(stagePattern.test(gate.stage), `Invalid security gate stage: ${gate.threatId}`)
    invariant(/^[a-z][a-z0-9_]*$/.test(gate.gateType), `Invalid gate type: ${gate.threatId}`)
    invariant(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gate.evidence),
      `Invalid gate evidence: ${gate.threatId}`
    )
  }
  return gateThreatIds.size
}

function verifyGateAssignment(item, label) {
  invariant(
    ['pr', 'nightly', 'release'].includes(item.gate?.execution),
    `${label} lacks an execution gate`
  )
  invariant(['ci', 'manual'].includes(item.gate?.automation), `${label} lacks gate automation`)
}

function verifySupportMatrix() {
  const document = readManifest('support-matrix.json')
  invariant(document.electron?.major === 43, 'Support matrix must match the Electron 43 line')
  invariant(document.electron.packageRange === '^43.1.0', 'Support matrix Electron range drifted')
  invariant(
    document.electron.supportSource.includes('/v43.1.1'),
    'Electron support evidence must use the fixed release tag'
  )

  const platformIds = uniqueValues(document.platforms, (platform) => platform.id, 'platform ID')
  for (const requiredPlatform of [
    'macos-12-arm64',
    'macos-12-x64',
    'windows-10-x64',
    'ubuntu-22.04-x64-x11',
    'ubuntu-22.04-x64-wayland'
  ]) {
    invariant(platformIds.has(requiredPlatform), `Support matrix lacks ${requiredPlatform}`)
  }
  document.platforms.forEach((platform) => verifyGateAssignment(platform, platform.id))

  const hostIds = uniqueValues(document.executionHosts, (host) => host.id, 'execution host ID')
  for (const requiredHost of ['native', 'wsl', 'ssh', 'relay']) {
    invariant(hostIds.has(requiredHost), `Support matrix lacks ${requiredHost} host`)
  }
  document.executionHosts.forEach((host) => verifyGateAssignment(host, host.id))

  const gitVersions = uniqueValues(document.gitVersions, (git) => git.version, 'Git version')
  invariant(gitVersions.has('2.25.0'), 'Support matrix lacks the Git 2.25 baseline')
  document.gitVersions.forEach((git) => verifyGateAssignment(git, `Git ${git.version}`))

  const providerIds = uniqueValues(
    document.agentProviders,
    (provider) => provider.id,
    'agent provider ID'
  )
  for (const providerId of ['claude-code', 'codex-cli']) {
    invariant(providerIds.has(providerId), `Support matrix lacks ${providerId}`)
  }
  for (const provider of document.agentProviders) {
    invariant(
      /^\d+\.\d+\.\d+$/.test(provider.version),
      `Provider version is not fixed: ${provider.id}`
    )
    invariant(
      ['known', 'unknown-additive', 'breaking'].every((fixture) =>
        provider.fixturePolicy.includes(fixture)
      ),
      `Provider fixture policy is incomplete: ${provider.id}`
    )
    verifyGateAssignment(provider, provider.id)
  }
}

export function verifyManifests(schemaIds) {
  verifyManifestCoverage()
  const permissionIds = verifyPermissionsAndRoles()
  verifyCapabilitiesAndEntitlements()
  verifyErrorsAndProtocols()
  const toolCount = verifyMcpTools(schemaIds, permissionIds)
  verifySourcesAndMigration()
  const securityGateCount = verifySecurityGates()
  verifySupportMatrix()
  return { securityGateCount, toolCount }
}
