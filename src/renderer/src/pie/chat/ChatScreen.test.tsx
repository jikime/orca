// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatScreen } from './ChatScreen'
import type { PieSessionState } from '../../../../shared/pie-session-contract'

const UID = '30000000-0000-4000-8000-000000000001'
const ORG = '30000000-0000-4000-8000-0000000000aa'

function authed(status: 'signed_in' | 'reauth_required'): PieSessionState {
  return {
    status,
    instanceId: 'local-desktop',
    userId: UID,
    displayName: 'Ada',
    organizationId: ORG,
    permissions: [],
    expiresAt: '2026-07-18T00:00:00.000Z'
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function render(session: PieSessionState): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<ChatScreen getSessionState={() => Promise.resolve(session)} />)
    await Promise.resolve()
  })
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

describe('ChatScreen auth states', () => {
  it('prompts re-login when a token refresh failed (reauth_required), not a silent 401', async () => {
    await render(authed('reauth_required'))
    expect(container?.textContent).toContain('session expired')
    expect(container?.querySelector('button')?.textContent).toContain('Sign in')
  })

  it('prompts a first-time sign-in when signed out', async () => {
    await render({ status: 'signed_out', instanceId: 'local-desktop' })
    expect(container?.textContent).toContain('Sign in to use Pie chat')
    expect(container?.querySelector('button')?.textContent).toContain('Sign in')
  })
})
