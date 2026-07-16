import {
  asyncApiPath,
  invariant,
  openApiPath,
  readYaml,
  verifyLocalReferences
} from './contract-file-io.mjs'

const httpMethods = ['get', 'post', 'put', 'patch', 'delete']

function expectedTag(route) {
  const tagByExactRoute = {
    '/.well-known/pie': 'Discovery',
    '/v1/organizations': 'Organizations',
    '/v1/session': 'Session'
  }
  if (tagByExactRoute[route]) {
    return tagByExactRoute[route]
  }
  for (const [fragment, tag] of [
    ['/memberships', 'Memberships'],
    ['/teams', 'Teams'],
    ['/projects', 'Projects'],
    ['/work-items', 'WorkItems'],
    ['/channels', 'Collaboration'],
    ['/dms', 'Collaboration'],
    ['/messages', 'Collaboration'],
    ['/notifications', 'Notifications'],
    ['/agent-events:batch', 'AgentIngest'],
    ['/artifacts/', 'Artifacts']
  ]) {
    if (route.includes(fragment)) {
      return tag
    }
  }
  if (route.endsWith('/changes')) {
    return 'Sync'
  }
  if (route.startsWith('/v1/operations/')) {
    return 'Operations'
  }
  return null
}

function hasParameterReference(operation, name) {
  return operation.parameters?.some(
    (parameter) => parameter.$ref === `#/components/parameters/${name}`
  )
}

function verifyOperation(route, method, operation, operationIds) {
  invariant(
    typeof operation.operationId === 'string',
    `Missing operationId: ${method.toUpperCase()} ${route}`
  )
  invariant(
    !operationIds.has(operation.operationId),
    `Duplicate operationId: ${operation.operationId}`
  )
  operationIds.add(operation.operationId)

  const tag = expectedTag(route)
  invariant(tag !== null, `Route has no ownership tag rule: ${route}`)
  invariant(
    Array.isArray(operation.tags) && operation.tags.length === 1 && operation.tags[0] === tag,
    `Wrong tag for ${method.toUpperCase()} ${route}; expected ${tag}`
  )
  invariant(
    operation.responses?.default?.$ref === '#/components/responses/Problem',
    `Missing default Problem response: ${operation.operationId}`
  )

  if (route.startsWith('/v1/')) {
    invariant(
      operation.security?.length !== 0,
      `Versioned operation disables authentication: ${operation.operationId}`
    )
  }
  if (['post', 'put', 'patch', 'delete'].includes(method)) {
    invariant(
      hasParameterReference(operation, 'IdempotencyKey'),
      `Mutation lacks Idempotency-Key: ${operation.operationId}`
    )
  }
  if (method === 'patch') {
    invariant(
      hasParameterReference(operation, 'IfMatch'),
      `PATCH lacks If-Match: ${operation.operationId}`
    )
  }
  if (operation.responses?.['201']) {
    invariant(
      operation.responses['201'].headers?.Location,
      `201 lacks Location: ${operation.operationId}`
    )
  }
}

export function verifyOpenApi() {
  const document = readYaml(openApiPath)
  invariant(document.openapi === '3.1.2', 'OpenAPI contract must use version 3.1.2')
  invariant(document.paths && typeof document.paths === 'object', 'OpenAPI must define paths')
  invariant(
    document.components?.securitySchemes?.PieOidc?.openIdConnectUrl?.startsWith(
      'https://auth.pielab.ai/'
    ),
    'OpenAPI OIDC example must use auth.pielab.ai'
  )
  verifyLocalReferences(document, openApiPath)

  const operationIds = new Set()
  for (const [route, pathItem] of Object.entries(document.paths)) {
    invariant(
      route === '/.well-known/pie' || route.startsWith('/v1/'),
      `Versioned API route required: ${route}`
    )
    for (const method of httpMethods) {
      if (pathItem[method]) {
        verifyOperation(route, method, pathItem[method], operationIds)
      }
    }
  }

  invariant(
    document.paths['/.well-known/pie']?.get?.security?.length === 0,
    'Instance discovery must remain unauthenticated'
  )
  return operationIds.size
}

export function verifyAsyncApi() {
  const document = readYaml(asyncApiPath)
  invariant(document.asyncapi === '3.0.0', 'AsyncAPI contract must use version 3.0.0')
  invariant(
    document.channels && document.operations,
    'AsyncAPI must define channels and operations'
  )
  invariant(
    document.servers?.production?.host === 'realtime.pielab.ai',
    'AsyncAPI host must use pielab.ai'
  )
  verifyLocalReferences(document, asyncApiPath)

  const messages = document.channels.realtime?.messages ?? {}
  for (const requiredMessage of [
    'ClientHello',
    'ServerWelcome',
    'ResourceChanged',
    'SessionRevoked',
    'ResyncRequired',
    'Heartbeat',
    'ConnectionClosing'
  ]) {
    invariant(messages[requiredMessage], `AsyncAPI lacks ${requiredMessage}`)
  }

  const operations = Object.values(document.operations)
  for (const operation of operations) {
    invariant(
      ['send', 'receive'].includes(operation.action),
      `Invalid AsyncAPI action: ${operation.action}`
    )
    invariant(
      Array.isArray(operation.messages) && operation.messages.length > 0,
      'AsyncAPI operation lacks messages'
    )
  }
  return { operationCount: operations.length, messageCount: Object.keys(messages).length }
}
