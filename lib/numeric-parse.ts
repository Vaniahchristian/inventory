/**
 * Shared parsing for OCR / JSON payloads so Postgres numeric columns never see junk ("." alone).
 * Used at extraction boundaries, validator sums, and Supabase inserts.
 */

export function parseFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const t = value.trim().replace(/,/g, '')
    if (t === '' || t === '.' || t === '-' || t === '+' || /^[+-]\.$/.test(t)) return null
    const n = parseFloat(t)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function parseFiniteInt(value: unknown): number | null {
  const n = parseFiniteNumber(value)
  if (n === null) return null
  const r = Math.round(n)
  return Number.isFinite(r) ? r : null
}
