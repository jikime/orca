import { verifyManifests } from './manifest-verification.mjs'
import {
  createSchemaRegistry,
  verifyBoundarySchemas,
  verifyFixtures
} from './schema-fixture-verification.mjs'
import { verifyAsyncApi, verifyOpenApi } from './wire-spec-verification.mjs'

function main() {
  const { ajv, schemaCount, schemaIds } = createSchemaRegistry()
  const fixtureCount = verifyFixtures(ajv)
  verifyBoundarySchemas()
  const httpOperationCount = verifyOpenApi()
  const realtime = verifyAsyncApi()
  const manifests = verifyManifests(schemaIds)

  console.log(
    `Contracts OK: ${schemaCount} schemas, ${fixtureCount} fixtures, ${httpOperationCount} HTTP operations, ${realtime.messageCount} realtime messages, ${manifests.toolCount} MCP tools, ${manifests.securityGateCount} P0 gates`
  )
}

main()
