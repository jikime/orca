import {
  PieResourceChangePageSchema,
  type PieRealtimeResourceChanged
} from '../../shared/pie-realtime-contract'

export type RealtimeChangesFetcherOptions = {
  apiBaseUrl: string
  organizationId: string
  // Supplies the current access token (from PieSessionTokenLifecycle via the Main
  // composition root — NEVER from the renderer). Returns null when signed out.
  getAccessToken: () => string | null
  fetchImpl?: typeof fetch
  limit?: number
  maxPages?: number
}

/**
 * Thin adapter that performs the authoritative REST listResourceChanges fetch
 * used during resync, keeping realtime-connection transport-pure. The response
 * is contract-validated before it is handed back.
 *
 * R3: the request now carries the verified bearer access token (the server derives
 * the org from the token subject + membership). The org stays in the path per the
 * contract, but the x-pie-organization-id authn stand-in is gone.
 */
export function createRealtimeChangesFetcher(
  options: RealtimeChangesFetcherOptions
): (afterCursor: string | null) => Promise<PieRealtimeResourceChanged[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  return async (afterCursor) => {
    const changes: PieRealtimeResourceChanged[] = []
    const maxPages = options.maxPages ?? 100
    let cursor = afterCursor
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const url = new URL(`/v1/organizations/${options.organizationId}/changes`, options.apiBaseUrl)
      if (cursor) {
        url.searchParams.set('after', cursor)
      }
      if (options.limit) {
        url.searchParams.set('limit', String(options.limit))
      }
      const token = options.getAccessToken()
      const response = await fetchImpl(url.toString(), {
        headers: token ? { authorization: `Bearer ${token}` } : {}
      })
      if (!response.ok) {
        throw new Error(`listResourceChanges failed with status ${response.status}`)
      }
      const page = PieResourceChangePageSchema.parse(await response.json())
      changes.push(...page.items)
      if (!page.hasMore) {
        return changes
      }
      // Why: a non-advancing recovery cursor would otherwise spin forever on a
      // malformed or incompatible server response.
      if (!page.nextCursor || page.nextCursor === cursor) {
        throw new Error('listResourceChanges returned a non-advancing cursor')
      }
      cursor = page.nextCursor
    }
    throw new Error(`listResourceChanges exceeded ${maxPages} pages`)
  }
}
