/**
 * RFC 4180 CSV with support for:
 * - Commas inside quoted fields
 * - Newlines inside quoted fields (SheetJS/XLSX.read breaks this — do not use XLSX for packing-list CSV)
 * - Escaped quotes ""
 */

export function parseCsvRows(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let i = 0
  let inQuotes = false

  while (i < text.length) {
    const c = text[i]

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }

    switch (c) {
      case '"':
        inQuotes = true
        i++
        break
      case ',':
        row.push(field)
        field = ''
        i++
        break
      case '\n':
        row.push(field)
        rows.push(row)
        row = []
        field = ''
        i++
        break
      case '\r':
        i++
        break
      default:
        field += c
        i++
    }
  }

  row.push(field)
  rows.push(row)

  return rows
}
