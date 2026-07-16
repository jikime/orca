import type { FastifyInstance } from 'fastify'
import type { ContractSchemaRegistry } from './contract-schema-registry'
import { buildInstanceDiscovery, type DiscoveryConfig } from './discovery-config'

const DISCOVERY_SCHEMA_ID = 'https://schemas.pielab.ai/discovery/instance-discovery.v1.schema.json'

export type DiscoveryRouteDeps = {
  registry: ContractSchemaRegistry
  config: DiscoveryConfig
}

export function registerDiscoveryRoute(app: FastifyInstance, deps: DiscoveryRouteDeps): void {
  app.get('/.well-known/pie', async () => {
    const document = buildInstanceDiscovery(deps.config, Date.now())
    const validate = deps.registry.ajv.getSchema(DISCOVERY_SCHEMA_ID)
    if (validate && validate(document) !== true) {
      // A discovery doc that fails its own contract is an internal error.
      throw new Error('discovery response violates the instance-discovery contract')
    }
    return document
  })
}
