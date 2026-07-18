// pg parses a `date` column into a local-midnight JS Date; the planning wire and the rollup
// min/max need a plain 'YYYY-MM-DD' string. Reconstructing from LOCAL components recovers the
// original calendar day regardless of the process timezone (slicing an ISO string would shift it).
export function toDateString(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'string') {
    return value.length > 10 ? value.slice(0, 10) : value
  }
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}
