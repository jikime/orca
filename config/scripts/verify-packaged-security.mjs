#!/usr/bin/env node
// ELC-005 evidence gate: `fuse-asar-signature-gate`.
//
// Given a packaged Orca app, verify the production security posture that fuses,
// ASAR integrity, and code signing are meant to guarantee:
//   - the flipped Electron fuse wire matches the values pinned in
//     electron-builder.config.cjs;
//   - (macOS) Info.plist embeds ElectronAsarIntegrity for app.asar and the
//     bundle passes `codesign --verify --strict`;
//   - (Windows) signtool is available to verify the Authenticode signature;
//   - app.asar exists and no unpacked bare `app/` directory shipped alongside it.
//
// The script never fakes a pass: anything it cannot check on the current host or
// for an unsigned dev build is reported UNVERIFIED, and only real mismatches
// exit non-zero. Decision logic is factored into pure functions (exported for
// unit tests) so tests do not need an actual packaged build.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const GATE_NAME = 'fuse-asar-signature-gate'

// Fuse wire indices come from @electron/fuses FuseV1Options. Values mirror
// electron-builder.config.cjs `electronFuses`; see that file for the rationale
// behind each (notably why RunAsNode and GrantFileProtocolExtraPrivileges stay
// enabled).
export const EXPECTED_FUSES = {
  RunAsNode: { index: 0, expected: true },
  EnableCookieEncryption: { index: 1, expected: true },
  EnableNodeOptionsEnvironmentVariable: { index: 2, expected: false },
  EnableNodeCliInspectArguments: { index: 3, expected: false },
  EnableEmbeddedAsarIntegrityValidation: { index: 4, expected: true },
  OnlyLoadAppFromAsar: { index: 5, expected: true },
  GrantFileProtocolExtraPrivileges: { index: 7, expected: true }
}

// @electron/fuses FuseState: ENABLE=49, DISABLE=48, REMOVED=114, INHERIT=144.
const FUSE_STATE_ENABLE = 49
const FUSE_STATE_DISABLE = 48

export function fuseStateToBool(state) {
  if (state === FUSE_STATE_ENABLE) {
    return true
  }
  if (state === FUSE_STATE_DISABLE) {
    return false
  }
  return null
}

/**
 * @param {Record<number, number>} wire fuse index -> FuseState, as returned by
 *   getCurrentFuseWire.
 */
export function evaluateFuses(wire, expected = EXPECTED_FUSES) {
  const rows = Object.entries(expected).map(([name, { index, expected: want }]) => {
    const actual = fuseStateToBool(wire?.[index])
    return {
      name,
      expected: want,
      actual,
      ok: actual === want
    }
  })
  return { rows, ok: rows.every((row) => row.ok) }
}

export function evaluateAsarLayout({ appAsarExists, bareAppDirExists }) {
  const issues = []
  if (!appAsarExists) {
    issues.push('app.asar is missing from the packaged resources')
  }
  if (bareAppDirExists) {
    issues.push('an unpacked bare app/ directory shipped next to app.asar')
  }
  return { ok: issues.length === 0, issues }
}

export function evaluateMacAsarIntegrity(infoPlistText) {
  if (typeof infoPlistText !== 'string' || infoPlistText.length === 0) {
    return { ok: false, detail: 'Info.plist is empty or unreadable' }
  }
  if (!infoPlistText.includes('ElectronAsarIntegrity')) {
    return { ok: false, detail: 'Info.plist has no ElectronAsarIntegrity block' }
  }
  if (!infoPlistText.includes('app.asar')) {
    return { ok: false, detail: 'ElectronAsarIntegrity does not reference app.asar' }
  }
  return { ok: true, detail: 'ElectronAsarIntegrity present for app.asar' }
}

export function formatSummaryTable(rows) {
  const header = ['CHECK', 'STATUS', 'DETAIL']
  const all = [header, ...rows.map((r) => [r.check, r.status, r.detail])]
  const widths = header.map((_, col) => Math.max(...all.map((r) => String(r[col]).length)))
  return all
    .map((row) => row.map((cell, col) => String(cell).padEnd(widths[col])).join('  '))
    .join('\n')
}

// --- IO layer (not unit-tested; exercised only against a real packaged app) ---

function resolveLayout(appPath, platform) {
  if (platform === 'darwin') {
    const resourcesDir = join(appPath, 'Contents', 'Resources')
    return {
      // getCurrentFuseWire resolves the Electron Framework from the .app path.
      electronPath: appPath,
      resourcesDir,
      infoPlistPath: join(appPath, 'Contents', 'Info.plist')
    }
  }
  // Windows/Linux: appPath is the unpacked app directory (win-unpacked /
  // linux-unpacked) that holds the executable and a resources/ dir.
  const executableName = platform === 'win32' ? 'Orca.exe' : 'orca-ide'
  return {
    electronPath: join(appPath, executableName),
    resourcesDir: join(appPath, 'resources'),
    infoPlistPath: null
  }
}

function runMacCodesign(appPath) {
  try {
    execFileSync('codesign', ['--verify', '--strict', '--verbose=2', appPath], { stdio: 'pipe' })
    return { status: 'PASS', detail: 'codesign --verify --strict passed' }
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : String(error?.message ?? error)
    // An unsigned dev build reports "code object is not signed at all"; that is
    // an expected, non-fatal state for a local build, not a tampering signal.
    if (/not signed at all/i.test(stderr)) {
      return { status: 'UNVERIFIED', detail: 'unsigned dev build (codesign: not signed)' }
    }
    return {
      status: 'FAIL',
      detail: `codesign rejected the bundle: ${stderr.trim().split('\n')[0]}`
    }
  }
}

function checkWindowsSigntool() {
  try {
    execFileSync('where', ['signtool'], { stdio: 'pipe' })
    return {
      status: 'UNVERIFIED',
      detail: 'signtool present; Authenticode check requires a signed build'
    }
  } catch {
    return { status: 'UNVERIFIED', detail: 'signtool not found on PATH; signature unverified' }
  }
}

async function main(argv) {
  const appPath = argv[2]
  if (!appPath) {
    console.error('usage: verify-packaged-security.mjs <path-to-packaged-app>')
    console.error('  macOS: path to Orca.app; Windows/Linux: path to the unpacked app dir')
    process.exit(2)
  }
  if (!existsSync(appPath)) {
    console.error(`[${GATE_NAME}] packaged app not found: ${appPath}`)
    process.exit(2)
  }

  const platform = process.platform
  const layout = resolveLayout(appPath, platform)
  const rows = []
  let hardFailure = false

  // 1. Fuse wire.
  try {
    const { getCurrentFuseWire } = await import('@electron/fuses')
    const wire = await getCurrentFuseWire(layout.electronPath)
    const { rows: fuseRows } = evaluateFuses(wire)
    for (const fuse of fuseRows) {
      if (!fuse.ok) {
        hardFailure = true
      }
      rows.push({
        check: `fuse:${fuse.name}`,
        status: fuse.ok ? 'PASS' : 'FAIL',
        detail: `expected ${fuse.expected}, got ${fuse.actual}`
      })
    }
  } catch (error) {
    hardFailure = true
    rows.push({
      check: 'fuse:wire',
      status: 'FAIL',
      detail: `could not read fuse wire: ${error?.message ?? error}`
    })
  }

  // 2. ASAR layout.
  const appAsarExists = existsSync(join(layout.resourcesDir, 'app.asar'))
  const bareAppDirExists = existsSync(join(layout.resourcesDir, 'app'))
  const asar = evaluateAsarLayout({ appAsarExists, bareAppDirExists })
  if (!asar.ok) {
    hardFailure = true
  }
  rows.push({
    check: 'asar:layout',
    status: asar.ok ? 'PASS' : 'FAIL',
    detail: asar.ok ? 'app.asar present, no bare app/ dir' : asar.issues.join('; ')
  })

  // 3. Platform signature + integrity.
  if (platform === 'darwin') {
    const plistText = existsSync(layout.infoPlistPath)
      ? readFileSync(layout.infoPlistPath, 'utf8')
      : ''
    const integrity = evaluateMacAsarIntegrity(plistText)
    if (!integrity.ok) {
      hardFailure = true
    }
    rows.push({
      check: 'asar:integrity(Info.plist)',
      status: integrity.ok ? 'PASS' : 'FAIL',
      detail: integrity.detail
    })
    const sign = runMacCodesign(appPath)
    if (sign.status === 'FAIL') {
      hardFailure = true
    }
    rows.push({ check: 'codesign', status: sign.status, detail: sign.detail })
  } else if (platform === 'win32') {
    const sign = checkWindowsSigntool()
    rows.push({ check: 'signtool', status: sign.status, detail: sign.detail })
    rows.push({
      check: 'asar:integrity',
      status: 'UNVERIFIED',
      detail: 'Windows integrity resource is embedded at build time; not readable here'
    })
  } else {
    rows.push({
      check: 'asar:integrity',
      status: 'UNVERIFIED',
      detail: 'Linux does not enforce ASAR integrity or code signing (accepted gap)'
    })
  }

  console.log(`\n[${GATE_NAME}] packaged security verification\n`)
  console.log(formatSummaryTable(rows))
  console.log(`\nGate: ${GATE_NAME} -> ${hardFailure ? 'FAIL' : 'PASS'}\n`)
  process.exit(hardFailure ? 1 : 0)
}

// Only run when invoked directly, so tests can import the pure functions.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).catch((error) => {
    console.error(`[${GATE_NAME}] unexpected error:`, error)
    process.exit(1)
  })
}
