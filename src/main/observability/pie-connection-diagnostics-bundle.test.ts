import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectBundle, _internalsForTests, type CollectBundleOptions } from './bundle'

const baseMeta: CollectBundleOptions = {
  // A path with no rotated family → no spans, so the tests isolate the section.
  traceFilePath: join(tmpdir(), `pie-conn-diag-${process.pid}-none`, 'trace.ndjson'),
  maxFiles: 1,
  appVersion: '1.4.142',
  platform: 'darwin',
  arch: 'arm64',
  osRelease: '24.0.0',
  orcaChannel: 'stable'
}

function payloadLines(payload: string): string[] {
  return payload.split('\n').filter((line) => line.length > 0)
}

describe('collectBundle connection diagnostics section', () => {
  it('emits the section as a line right after the header', () => {
    const section = {
      type: 'pie-connection-diagnostics',
      schemaVersion: 1,
      safeMode: { active: true }
    }
    const bundle = collectBundle({ ...baseMeta, connectionDiagnostics: section })
    const lines = payloadLines(bundle.payload)
    expect(JSON.parse(lines[0]).type).toBe('bundle-header')
    expect(JSON.parse(lines[1])).toMatchObject({ type: 'pie-connection-diagnostics' })
    // The section is not a span.
    expect(bundle.spanCount).toBe(0)
  })

  it('re-redacts the section server-side even if a raw token slips in', () => {
    const canary = `ghp_${'b'.repeat(40)}`
    const bundle = collectBundle({
      ...baseMeta,
      connectionDiagnostics: { type: 'pie-connection-diagnostics', session: { instanceId: canary } }
    })
    expect(bundle.payload.includes(canary)).toBe(false)
  })

  it('drops an oversized section rather than exceeding the byte cap', () => {
    const huge = 'x'.repeat(_internalsForTests.MAX_BUNDLE_BYTES + 1024)
    const bundle = collectBundle({
      ...baseMeta,
      connectionDiagnostics: { type: 'pie-connection-diagnostics', blob: huge }
    })
    expect(bundle.bytes).toBeLessThanOrEqual(_internalsForTests.MAX_BUNDLE_BYTES)
    // Only the header survives; the oversized section was not appended.
    expect(payloadLines(bundle.payload)).toHaveLength(1)
  })
})
