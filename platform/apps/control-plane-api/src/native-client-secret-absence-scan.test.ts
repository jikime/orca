import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// AUT-003 evidence: native-client-secret-absence-scan (contracts/manifests/
// security-gates.json). The native desktop app is a PUBLIC OAuth client — it must
// carry NO client secret anywhere. This is the named, runnable artifact matching
// the manifest evidence string.

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const REALM_PATH = join(REPO_ROOT, 'deploy/keycloak/pie-realm.json')
const DESKTOP_CLIENT_ID = 'pie-desktop'

const SCAN_ROOTS = ['deploy', 'platform/apps', 'platform/packages', 'src']
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.env']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', '.git'])
// A client secret tied to the desktop client would be a fatal AUT-003 finding.
const SECRET_TOKEN = /client[_-]?secret|clientSecret/i

function* walk(dir: string): Iterable<string> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) {
      continue
    }
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      yield* walk(full)
    } else if (SCAN_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      yield full
    }
  }
}

describe('native-client-secret-absence-scan (AUT-003)', () => {
  it('marks the pie-desktop realm client as public with no secret', () => {
    const realm = JSON.parse(readFileSync(REALM_PATH, 'utf-8')) as {
      clients: {
        clientId: string
        publicClient?: boolean
        secret?: string
        clientSecret?: string
      }[]
    }
    const client = realm.clients.find((c) => c.clientId === DESKTOP_CLIENT_ID)
    expect(client, 'realm must define the pie-desktop client').toBeDefined()
    expect(client!.publicClient).toBe(true)
    expect(client).not.toHaveProperty('secret')
    expect(client).not.toHaveProperty('clientSecret')
  })

  it('finds no client-secret material tied to the desktop client in source or deploy files', () => {
    const selfPath = fileURLToPath(import.meta.url)
    const offenders: string[] = []
    for (const root of SCAN_ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        // The scanner itself necessarily contains both tokens as detection
        // patterns; exclude it so it does not flag itself.
        if (file === selfPath) {
          continue
        }
        // Test files are not shipped client artifacts; a test that ASSERTS the
        // public client sends no client_secret is evidence FOR the gate, not
        // secret material. The scan targets source/deploy/realm that ships.
        if (/\.test\.[cm]?[jt]s$/.test(file)) {
          continue
        }
        const content = readFileSync(file, 'utf-8')
        // A secret is a finding only when it is tied to the desktop client — a
        // confidential service client elsewhere legitimately has one.
        if (content.includes(DESKTOP_CLIENT_ID) && SECRET_TOKEN.test(content)) {
          offenders.push(file.slice(REPO_ROOT.length))
        }
      }
    }
    expect(offenders, `client secret material near ${DESKTOP_CLIENT_ID}`).toEqual([])
  })
})
