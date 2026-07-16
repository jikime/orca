import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020'
import addFormats from 'ajv-formats'

// All contracts/schemas loaded into one Ajv 2020 instance keyed by $id, so the
// remote https://schemas.pielab.ai/ cross-refs resolve locally (same approach as
// the repo's contract verifier). Used to validate every inbound/outbound Realtime
// message against its contract before it crosses the wire.
const SCHEMAS_DIR = fileURLToPath(new URL('../../../../contracts/schemas', import.meta.url))

export const REALTIME_MESSAGE_SCHEMA_ID: Record<string, string> = {
  'client.hello': 'https://schemas.pielab.ai/events/realtime-client-hello.v1.schema.json',
  'server.welcome': 'https://schemas.pielab.ai/events/realtime-server-welcome.v1.schema.json',
  'resource.changed': 'https://schemas.pielab.ai/events/realtime-resource-changed.v1.schema.json',
  'resync.required': 'https://schemas.pielab.ai/events/realtime-resync-required.v1.schema.json',
  heartbeat: 'https://schemas.pielab.ai/events/realtime-heartbeat.v1.schema.json',
  'connection.closing':
    'https://schemas.pielab.ai/events/realtime-connection-closing.v1.schema.json',
  'session.revoked': 'https://schemas.pielab.ai/events/realtime-session-revoked.v1.schema.json'
}

function* walkJsonFiles(directory: string): Iterable<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      yield* walkJsonFiles(full)
    } else if (entry.name.endsWith('.schema.json')) {
      yield full
    }
  }
}

export type ContractSchemaRegistry = {
  validate: (messageType: string, message: unknown) => boolean
  validatorFor: (messageType: string) => ValidateFunction
  ajv: Ajv2020
}

export function createContractSchemaRegistry(): ContractSchemaRegistry {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  addFormats(ajv)
  for (const file of walkJsonFiles(SCHEMAS_DIR)) {
    const schema = JSON.parse(readFileSync(file, 'utf-8')) as { $id?: string }
    if (schema.$id && !ajv.getSchema(schema.$id)) {
      ajv.addSchema(schema)
    }
  }

  const validatorFor = (messageType: string): ValidateFunction => {
    const schemaId = REALTIME_MESSAGE_SCHEMA_ID[messageType]
    const validate = schemaId ? ajv.getSchema(schemaId) : undefined
    if (!validate) {
      throw new Error(`no contract schema for realtime message type ${messageType}`)
    }
    return validate as ValidateFunction
  }

  return {
    ajv,
    validatorFor,
    validate: (messageType, message) => {
      const rawType =
        message && typeof message === 'object' ? (message as { type?: unknown }).type : undefined
      // A message whose type does not match the claimed slot never validates.
      if (rawType !== messageType) {
        return false
      }
      return validatorFor(messageType)(message) === true
    }
  }
}
