import {
  PieResourceChangePageSchema,
  type PieRealtimeResourceChanged
} from '../../shared/pie-realtime-contract'

export type RealtimeChangesFetcherOptions = {
  apiBaseUrl: string
  organizationId: string
  fetchImpl?: typeof fetch
  limit?: number
}

/**
 * Thin adapter that performs the authoritative REST listResourceChanges fetch
 * used during resync, keeping realtime-connection transport-pure. The response
 * is contract-validated before it is handed back.
 *
 * R3 trust gap: org identity is carried in the x-pie-organization-id header as an
 * authn stand-in — exactly like the platform REST side — and R3 replaces it with
 * the authenticated token subject + membership check.
 */
export function createRealtimeChangesFetcher(
  options: RealtimeChangesFetcherOptions
): (afterCursor: string | null) => Promise<PieRealtimeResourceChanged[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  return async (afterCursor) => {
    const url = new URL(`/v1/organizations/${options.organizationId}/changes`, options.apiBaseUrl)
    if (afterCursor) {
      url.searchParams.set('after', afterCursor)
    }
    if (options.limit) {
      url.searchParams.set('limit', String(options.limit))
    }
    const response = await fetchImpl(url.toString(), {
      headers: { 'x-pie-organization-id': options.organizationId }
    })
    if (!response.ok) {
      throw new Error(`listResourceChanges failed with status ${response.status}`)
    }
    const page = PieResourceChangePageSchema.parse(await response.json())
    return page.items
  }
}
