import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet } from './pie-api-client'

export type PieResourceState<T> = {
  data: T | null
  loading: boolean
  error: string | null
  refetch: () => void
}

// Fetches an org-scoped control-plane GET into React state, with a manual refetch
// (e.g. after a mutation). A null path suspends fetching (for a not-yet-selected
// detail). A response for a path the caller navigated away from is ignored.
export function usePieResource<T>(path: string | null): PieResourceState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(path !== null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const loadedPathRef = useRef<string | null>(null)

  const refetch = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (path === null) {
      loadedPathRef.current = null
      setData(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    const initialLoad = loadedPathRef.current !== path
    if (initialLoad) {
      loadedPathRef.current = null
      setData(null)
      setLoading(true)
      setError(null)
    }
    apiGet<T>(path)
      .then((result) => {
        if (!cancelled) {
          loadedPathRef.current = path
          setData(result)
          setError(null)
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'request failed')
        }
      })
      .finally(() => {
        // Why: polling refreshes keep rendered data in place; re-entering initial
        // loading here caused fast requests to collapse and restore whole panels.
        if (!cancelled && initialLoad) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [path, nonce])

  return { data, loading, error, refetch }
}
