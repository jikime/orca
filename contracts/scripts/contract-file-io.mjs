import fs from 'node:fs'
import path from 'node:path'

import YAML from 'yaml'

export const contractsDirectory = path.resolve(import.meta.dirname, '..')
export const schemaDirectory = path.join(contractsDirectory, 'schemas')
export const fixtureDirectory = path.join(contractsDirectory, 'fixtures')
export const manifestDirectory = path.join(contractsDirectory, 'manifests')
export const openApiPath = path.join(contractsDirectory, 'openapi', 'pie-control-plane-v1.yaml')
export const asyncApiPath = path.join(contractsDirectory, 'asyncapi', 'pie-realtime-v1.yaml')
export const threatModelPath = path.resolve(
  contractsDirectory,
  '..',
  'pie-docs',
  '24-security-threat-model.md'
)

export function invariant(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

export function listFiles(directory, extension) {
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort()
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

export function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

export function readYaml(filePath) {
  return YAML.parse(readText(filePath))
}

function resolveJsonPointer(document, fragment, sourcePath) {
  if (!fragment) {
    return document
  }
  invariant(
    fragment.startsWith('/'),
    `Unsupported reference fragment in ${sourcePath}: #${fragment}`
  )

  return fragment
    .slice(1)
    .split('/')
    .map((part) => decodeURIComponent(part).replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((current, part) => {
      invariant(
        current !== null && typeof current === 'object' && part in current,
        `Missing reference #${fragment} in ${sourcePath}`
      )
      return current[part]
    }, document)
}

export function verifyLocalReferences(document, sourcePath) {
  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (value === null || typeof value !== 'object') {
      return
    }

    if (typeof value.$ref === 'string' && !/^https?:\/\//.test(value.$ref)) {
      const [relativePath, fragment = ''] = value.$ref.split('#', 2)
      const targetPath = relativePath
        ? path.resolve(path.dirname(sourcePath), relativePath)
        : sourcePath
      invariant(
        fs.existsSync(targetPath),
        `Missing local reference ${value.$ref} from ${sourcePath}`
      )
      const target = targetPath.endsWith('.json') ? readJson(targetPath) : readYaml(targetPath)
      resolveJsonPointer(target, fragment, targetPath)
    }

    Object.values(value).forEach(visit)
  }

  visit(document)
}

export function collectObjectKeys(value, result = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjectKeys(item, result))
    return result
  }
  if (value === null || typeof value !== 'object') {
    return result
  }
  for (const [key, child] of Object.entries(value)) {
    result.add(key)
    collectObjectKeys(child, result)
  }
  return result
}

export function collectStringValues(value, result = []) {
  if (typeof value === 'string') {
    result.push(value)
    return result
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectStringValues(item, result))
    return result
  }
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((child) => collectStringValues(child, result))
  }
  return result
}
