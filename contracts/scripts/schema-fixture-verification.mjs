import fs from 'node:fs'
import path from 'node:path'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import {
  collectObjectKeys,
  collectStringValues,
  fixtureDirectory,
  invariant,
  listFiles,
  readJson,
  schemaDirectory
} from './contract-file-io.mjs'

const schemaIdPrefix = 'https://schemas.pielab.ai/'
const forbiddenBoundaryKeys = new Set([
  'accessToken',
  'refreshToken',
  'idToken',
  'clientSecret',
  'password',
  'localPath'
])

export function createSchemaRegistry() {
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true })
  addFormats(ajv)
  const schemaFiles = listFiles(schemaDirectory, '.json')
  const schemaIds = new Set()

  for (const filePath of schemaFiles) {
    const schema = readJson(filePath)
    invariant(typeof schema.$id === 'string', `Schema lacks $id: ${filePath}`)
    invariant(schema.$id.startsWith(schemaIdPrefix), `Schema uses the wrong domain: ${schema.$id}`)
    invariant(!schemaIds.has(schema.$id), `Duplicate schema $id: ${schema.$id}`)
    schemaIds.add(schema.$id)
    ajv.addSchema(schema)
  }

  for (const schemaId of schemaIds) {
    invariant(ajv.getSchema(schemaId), `Schema did not compile: ${schemaId}`)
  }
  return { ajv, schemaCount: schemaFiles.length, schemaIds }
}

function verifyBoundaryDocument(document, fixtureName) {
  const keys = collectObjectKeys(document)
  for (const key of forbiddenBoundaryKeys) {
    invariant(!keys.has(key), `Sensitive or host-local field ${key} in ${fixtureName}`)
  }
}

function verifyPortableFixtureValues(document, fixtureName) {
  for (const value of collectStringValues(document)) {
    invariant(
      !/^(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private)\/)/.test(value),
      `Local absolute path in ${fixtureName}`
    )
    invariant(
      !/[?&]X-Amz-(?:Credential|Signature)=/i.test(value),
      `Presigned URL in ${fixtureName}`
    )
  }
}

export function verifyFixtures(ajv) {
  const indexPath = path.join(fixtureDirectory, 'fixture-index.json')
  const index = readJson(indexPath)
  invariant(
    index.schemaVersion === 1 && Array.isArray(index.cases),
    'Fixture index must use schemaVersion 1'
  )

  const indexedPaths = new Set()
  const caseNames = new Set()
  for (const fixtureCase of index.cases) {
    invariant(!caseNames.has(fixtureCase.name), `Duplicate fixture case: ${fixtureCase.name}`)
    caseNames.add(fixtureCase.name)

    const validate = ajv.getSchema(fixtureCase.schemaId)
    invariant(validate, `Unknown fixture schema: ${fixtureCase.schemaId}`)
    const documentPath = path.resolve(fixtureDirectory, fixtureCase.document)
    invariant(
      documentPath.startsWith(`${fixtureDirectory}${path.sep}`),
      `Fixture escapes directory: ${fixtureCase.document}`
    )
    invariant(fs.existsSync(documentPath), `Missing fixture: ${fixtureCase.document}`)
    invariant(!indexedPaths.has(documentPath), `Fixture indexed twice: ${fixtureCase.document}`)
    indexedPaths.add(documentPath)

    const document = readJson(documentPath)
    const actualValid = validate(document)
    if (actualValid !== fixtureCase.expectedValid) {
      throw new Error(
        `Fixture ${fixtureCase.document} expected valid=${fixtureCase.expectedValid}: ${ajv.errorsText(validate.errors)}`
      )
    }

    if (fixtureCase.expectedValid) {
      verifyPortableFixtureValues(document, fixtureCase.document)
      if (/^(?:valid|compatibility)\/(?:ipc-|mcp-)/.test(fixtureCase.document)) {
        verifyBoundaryDocument(document, fixtureCase.document)
      }
    }
  }

  const fixtureFiles = listFiles(fixtureDirectory, '.json').filter(
    (filePath) => filePath !== indexPath
  )
  for (const fixturePath of fixtureFiles) {
    invariant(indexedPaths.has(fixturePath), `Fixture is not indexed: ${fixturePath}`)
  }
  invariant(indexedPaths.size === fixtureFiles.length, 'Fixture index does not match fixture set')
  return index.cases.length
}

export function verifyBoundarySchemas() {
  for (const boundary of ['ipc', 'mcp']) {
    const directory = path.join(schemaDirectory, boundary)
    for (const filePath of listFiles(directory, '.json')) {
      const keys = collectObjectKeys(readJson(filePath))
      for (const key of forbiddenBoundaryKeys) {
        invariant(!keys.has(key), `Sensitive or host-local field ${key} in ${filePath}`)
      }
    }
  }
}
