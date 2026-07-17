import fs from 'node:fs'
import path from 'node:path'

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'

import {
  ExecutionContextGetOutputSchema,
  ProjectsListOutputSchema,
  WorkItemCommentCreateOutputSchema
} from './pie-mcp-tool-io-schemas'

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const schemaRoot = path.join(repoRoot, 'contracts/schemas')
const fixtureRoot = path.join(repoRoot, 'contracts/fixtures')

// Independent, ajv-backed assertion of I/O against the FROZEN JSON schema files —
// so the zod mirrors that drive the server cannot silently diverge from contract.
function buildAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allowUnionTypes: true, strict: false })
  addFormats(ajv)
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.json')) {
        ajv.addSchema(JSON.parse(fs.readFileSync(full, 'utf8')))
      }
    }
  }
  walk(schemaRoot)
  return ajv
}

function validator(ajv: Ajv2020, id: string): ValidateFunction {
  const compiled = ajv.getSchema(`https://schemas.pielab.ai/mcp/${id}`)
  if (!compiled) {
    throw new Error(`schema not found: ${id}`)
  }
  return compiled as ValidateFunction
}

function fixture(relative: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, relative), 'utf8'))
}

const ajv = buildAjv()

describe('pie-mcp contract conformance (ajv against JSON schema files)', () => {
  it('ACCEPTS the valid input fixtures against their input schemas', () => {
    expect(
      validator(
        ajv,
        'projects-list-input.v1.schema.json'
      )(fixture('valid/mcp-projects-list-input.json'))
    ).toBe(true)
    expect(
      validator(
        ajv,
        'work-item-comment-create-input.v1.schema.json'
      )(fixture('valid/mcp-work-item-comment-create-input.json'))
    ).toBe(true)
  })

  it('REJECTS the token-passthrough input against the projects-list-input schema', () => {
    expect(
      validator(
        ajv,
        'projects-list-input.v1.schema.json'
      )(fixture('invalid/mcp-projects-list-token-passthrough.json'))
    ).toBe(false)
  })

  it('REJECTS the missing-idempotency write against the comment-create-input schema', () => {
    expect(
      validator(
        ajv,
        'work-item-comment-create-input.v1.schema.json'
      )(fixture('invalid/mcp-comment-missing-idempotency.json'))
    ).toBe(false)
  })

  it('ACCEPTS the execution-context output fixture and its unknown-optional-field variant', () => {
    const validate = validator(ajv, 'execution-context-get-output.v1.schema.json')
    expect(validate(fixture('valid/mcp-execution-context-output.json'))).toBe(true)
    expect(validate(fixture('compatibility/mcp-execution-context-unknown-optional.json'))).toBe(
      true
    )
  })

  it('validates a produced projects.list output against the output schema', () => {
    const output = ProjectsListOutputSchema.parse({
      items: [
        {
          id: '10000000-0000-4000-8000-000000000002',
          organizationId: '20000000-0000-4000-8000-000000000001',
          name: 'Portal',
          status: 'active',
          version: 1,
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:00.000Z'
        }
      ],
      nextCursor: null
    })
    expect(validator(ajv, 'projects-list-output.v1.schema.json')(output)).toBe(true)
  })

  it('validates a produced comment.create output against the output schema', () => {
    const output = WorkItemCommentCreateOutputSchema.parse({
      comment: {
        id: '20000000-0000-4000-8000-000000000007',
        organizationId: '20000000-0000-4000-8000-000000000001',
        workItemId: '10000000-0000-4000-8000-000000000003',
        authorId: '20000000-0000-4000-8000-000000000004',
        body: 'done',
        visibility: 'internal',
        createdAt: '2026-07-16T00:00:00.000Z'
      },
      workItemVersion: 2,
      correlationId: '10000000-0000-4000-8000-000000000002'
    })
    expect(validator(ajv, 'work-item-comment-create-output.v1.schema.json')(output)).toBe(true)
  })

  it('zod output mirror tolerates the unknown-optional compatibility fixture', () => {
    const parsed = ExecutionContextGetOutputSchema.safeParse(
      fixture('compatibility/mcp-execution-context-unknown-optional.json')
    )
    expect(parsed.success).toBe(true)
  })
})
