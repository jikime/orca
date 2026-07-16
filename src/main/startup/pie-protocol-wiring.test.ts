import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Pie protocol lifecycle wiring', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  it('registers macOS open-url handling before Electron ready', () => {
    const registrationIndex = source.indexOf(
      'registerPieProtocolOpenUrlHandler(app, handlePieOpenUrl)'
    )
    const readyIndex = source.indexOf('app.whenReady().then(async () => {')

    expect(registrationIndex).toBeGreaterThanOrEqual(0)
    expect(registrationIndex).toBeLessThan(readyIndex)
  })

  it('routes initial and second-instance command lines through the same parser', () => {
    expect(source).toContain("routePieProtocolCommandLine(process.argv, 'initial-launch')")
    expect(source).toContain("routePieProtocolCommandLine(commandLine, 'second-instance')")
    expect(source).toContain('acquireSingleInstanceLock(app, handleSecondInstance)')
  })

  it('does not interpolate raw callback URLs into diagnostics', () => {
    expect(source).not.toContain('console.warn(`[pie-deep-link] ${rawUrl}')
    expect(source).toContain('auth callback: ${result.reason}')
  })
})
