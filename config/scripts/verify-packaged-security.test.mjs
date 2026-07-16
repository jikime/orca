import { describe, expect, it } from 'vitest'
import {
  EXPECTED_FUSES,
  evaluateAsarLayout,
  evaluateFuses,
  evaluateMacAsarIntegrity,
  formatSummaryTable,
  fuseStateToBool
} from './verify-packaged-security.mjs'

const ENABLE = 49
const DISABLE = 48
const INHERIT = 144

// Build a wire object that satisfies every pinned expectation.
function compliantWire() {
  const wire = { version: '1' }
  for (const { index, expected } of Object.values(EXPECTED_FUSES)) {
    wire[index] = expected ? ENABLE : DISABLE
  }
  return wire
}

describe('fuseStateToBool', () => {
  it('maps ENABLE/DISABLE and treats other states as unknown', () => {
    expect(fuseStateToBool(ENABLE)).toBe(true)
    expect(fuseStateToBool(DISABLE)).toBe(false)
    expect(fuseStateToBool(INHERIT)).toBe(null)
    expect(fuseStateToBool(undefined)).toBe(null)
  })
})

describe('evaluateFuses', () => {
  it('passes when the wire matches every pinned expectation', () => {
    const { ok, rows } = evaluateFuses(compliantWire())
    expect(ok).toBe(true)
    expect(rows).toHaveLength(Object.keys(EXPECTED_FUSES).length)
  })

  // Why: RunAsNode must stay enabled for the CLI launchers and forked daemon;
  // a build that disabled it should fail the gate loudly.
  it('fails when RunAsNode was disabled', () => {
    const wire = compliantWire()
    wire[EXPECTED_FUSES.RunAsNode.index] = DISABLE
    const { ok, rows } = evaluateFuses(wire)
    expect(ok).toBe(false)
    expect(rows.find((r) => r.name === 'RunAsNode')).toMatchObject({
      expected: true,
      actual: false,
      ok: false
    })
  })

  it('fails when a fuse that must be off got left on', () => {
    const wire = compliantWire()
    wire[EXPECTED_FUSES.EnableNodeCliInspectArguments.index] = ENABLE
    const { ok } = evaluateFuses(wire)
    expect(ok).toBe(false)
  })

  it('fails when a fuse is absent (INHERIT) rather than explicitly set', () => {
    const wire = compliantWire()
    wire[EXPECTED_FUSES.OnlyLoadAppFromAsar.index] = INHERIT
    const { ok } = evaluateFuses(wire)
    expect(ok).toBe(false)
  })
})

describe('evaluateAsarLayout', () => {
  it('passes with app.asar present and no bare app dir', () => {
    expect(evaluateAsarLayout({ appAsarExists: true, bareAppDirExists: false })).toEqual({
      ok: true,
      issues: []
    })
  })

  it('flags a missing app.asar', () => {
    const result = evaluateAsarLayout({ appAsarExists: false, bareAppDirExists: false })
    expect(result.ok).toBe(false)
    expect(result.issues[0]).toMatch(/app\.asar is missing/)
  })

  it('flags a bare app/ directory that would bypass onlyLoadAppFromAsar intent', () => {
    const result = evaluateAsarLayout({ appAsarExists: true, bareAppDirExists: true })
    expect(result.ok).toBe(false)
    expect(result.issues[0]).toMatch(/bare app\/ directory/)
  })
})

describe('evaluateMacAsarIntegrity', () => {
  it('passes when Info.plist embeds ElectronAsarIntegrity for app.asar', () => {
    const plist = `
      <key>ElectronAsarIntegrity</key>
      <dict><key>Resources/app.asar</key><dict><key>hash</key><string>deadbeef</string></dict></dict>`
    expect(evaluateMacAsarIntegrity(plist).ok).toBe(true)
  })

  it('fails when the integrity block is absent', () => {
    expect(evaluateMacAsarIntegrity('<key>CFBundleName</key><string>Orca</string>').ok).toBe(false)
  })

  it('fails on empty input', () => {
    expect(evaluateMacAsarIntegrity('').ok).toBe(false)
  })
})

describe('formatSummaryTable', () => {
  it('renders aligned rows with the header', () => {
    const table = formatSummaryTable([{ check: 'fuse:RunAsNode', status: 'PASS', detail: 'ok' }])
    expect(table).toContain('CHECK')
    expect(table).toContain('fuse:RunAsNode')
    expect(table).toContain('PASS')
  })
})
