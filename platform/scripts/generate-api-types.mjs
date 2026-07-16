// Generates DTO types for the Control Plane OpenAPI into generated/.
//
// The OpenAPI $refs contracts/schemas/* by relative path, and those schema files
// $ref each other by their canonical https://schemas.pielab.ai/ $id URIs.
// openapi-typescript (via Redocly) would fetch those $ids over the network, so we
// pre-dereference every EXTERNAL $ref from the local files first — the same
// $id -> file mapping the Ajv contract verifier uses — and hand a self-contained
// document to the generator. In-document (#/...) refs are left for Redocly.
//
// Do not hand-edit generated output — re-run `pnpm gen:api-types`.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import openapiTS, { astToString } from 'openapi-typescript'

const SCHEMA_ID_PREFIX = 'https://schemas.pielab.ai/'
const openapiPath = fileURLToPath(
  new URL('../../contracts/openapi/pie-control-plane-v1.yaml', import.meta.url)
)
const schemasDir = fileURLToPath(new URL('../../contracts/schemas', import.meta.url))
const generatedDir = fileURLToPath(new URL('../generated/', import.meta.url))
const outputPath = resolve(generatedDir, 'control-plane-api-types.ts')

async function loadExternalSchema(ref, baseDir) {
  const filePath = ref.startsWith(SCHEMA_ID_PREFIX)
    ? resolve(schemasDir, ref.slice(SCHEMA_ID_PREFIX.length))
    : resolve(baseDir, ref)
  const parsed = JSON.parse(await readFile(filePath, 'utf-8'))
  return { schema: parsed, baseDir: dirname(filePath) }
}

// Resolve a `#/a/b` JSON pointer against a document root (RFC 6901 unescaping).
function resolveJsonPointer(docRoot, ref) {
  const segments = ref
    .replace(/^#\/?/, '')
    .split('/')
    .filter((segment) => segment.length > 0)
  let current = docRoot
  for (const segment of segments) {
    current = current?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')]
  }
  return current
}

// Fully inlines every $ref: external file refs load their file (which becomes the
// new document root for that subtree), and `#/...` pointers resolve against the
// current document root — so a schema file's intra-file `#/$defs/...` refs stay
// bound to that file after inlining. A ref already on the resolution stack is a
// cycle — collapse it to `{}` so types degrade gracefully instead of looping.
async function dereference(node, baseDir, docRoot, stack) {
  if (Array.isArray(node)) {
    return Promise.all(node.map((item) => dereference(item, baseDir, docRoot, stack)))
  }
  if (!node || typeof node !== 'object') return node
  if (typeof node.$ref === 'string') {
    const ref = node.$ref
    if (stack.includes(ref)) return {}
    if (ref.startsWith('#')) {
      return dereference(resolveJsonPointer(docRoot, ref), baseDir, docRoot, [...stack, ref])
    }
    const { schema, baseDir: nextBaseDir } = await loadExternalSchema(ref, baseDir)
    return dereference(schema, nextBaseDir, schema, [...stack, ref])
  }
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    // Meta and ref-target-only keys are not needed once everything is inlined.
    if (key === '$schema' || key === '$id' || key === '$defs' || key === 'definitions') {
      continue
    }
    out[key] = await dereference(value, baseDir, docRoot, stack)
  }
  return out
}

const openapiDocument = parseYaml(await readFile(openapiPath, 'utf-8'))
const bundled = await dereference(openapiDocument, dirname(openapiPath), openapiDocument, [])
const ast = await openapiTS(bundled)
await mkdir(generatedDir, { recursive: true })
await writeFile(outputPath, astToString(ast), 'utf-8')
console.log(`Wrote ${outputPath}`)
