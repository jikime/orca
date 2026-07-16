import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'

// Proves the platform can consume the real JSON Schema 2020-12 contracts (not
// just an inline demo schema) through the same Ajv2020 build the API uses.
const PROBLEM_SCHEMA_PATH = fileURLToPath(
  new URL('../../../../contracts/schemas/common/problem-details.v1.schema.json', import.meta.url)
)

describe('Ajv2020 consumes contracts/schemas', () => {
  it('compiles and enforces problem-details.v1 (2020-12 dialect)', () => {
    const schema = JSON.parse(readFileSync(PROBLEM_SCHEMA_PATH, 'utf-8'))
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')

    const ajv = new Ajv2020({ allErrors: true, strict: false })
    addFormats(ajv)
    const validate = ajv.compile(schema)

    expect(
      validate({
        type: 'https://pielab.ai/problems/not-found',
        title: 'Not Found',
        status: 404,
        code: 'NOT_FOUND',
        requestId: '0af7651916cd43dd8448eb211c80319c'
      })
    ).toBe(true)
    // Missing required `code` → invalid.
    expect(validate({ type: 'about:blank', title: 'x', status: 404, requestId: 'abcd1234' })).toBe(
      false
    )
  })
})
