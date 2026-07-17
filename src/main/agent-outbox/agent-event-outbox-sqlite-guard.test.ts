import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { probeSqlite } from './agent-event-outbox-sqlite-guard'

const dir = mkdtempSync(join(tmpdir(), 'outbox-guard-'))

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('agent-event-outbox-sqlite-guard', () => {
  it('reports the packaged SQLite as usable in memory (WAL not applicable)', () => {
    const result = probeSqlite(':memory:')
    expect(result.usable).toBe(true)
    expect(result.sqliteVersion).toBeTruthy()
    // :memory: reports `memory` journal mode, so WAL is not applicable — still usable.
    expect(result.walSupported).toBe(false)
  })

  it('confirms WAL is accepted on a real file', () => {
    const result = probeSqlite(join(dir, 'probe.db'))
    expect(result.usable).toBe(true)
    expect(result.walSupported).toBe(true)
  })
})
