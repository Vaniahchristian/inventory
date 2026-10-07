import {
  detectDocTypeFromFilename,
  filenameSuggestsContainerManifest,
  isContainerManifestSpreadsheetPreview,
} from '@/lib/prompts'

/**
 * Chooses exactly **one** Next route per spreadsheet:
 * - **sales** → `/api/import-sales-excel` (existing Python `/import` proxy — unchanged)
 * - **manifest** → `/api/import-manifest` (Python `/import/manifest`)
 *
 * Content beats filename for CSV: a packing list named `sales.csv` (MARKS / T.CTN / T.QTY)
 * must go to the manifest importer, not the sales-order path.
 */
export async function pickSpreadsheetImportKind(file: File): Promise<'manifest' | 'sales'> {
  const name = file.name
  const lower = name.toLowerCase()

  if (lower.endsWith('.csv')) {
    const head = await file.slice(0, Math.min(file.size, 96 * 1024)).text()
    const lines = head
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 120)
    if (isContainerManifestSpreadsheetPreview(lines)) {
      return 'manifest'
    }
  }

  if (filenameSuggestsContainerManifest(name)) {
    return 'manifest'
  }
  if (detectDocTypeFromFilename(name) === 'sales_order') {
    return 'sales'
  }
  if (lower.endsWith('.csv')) {
    return 'sales'
  }
  // .xlsx / .xls / .xlsm: without MS-*/manifest in the name, keep the **existing** sales path
  // (same as before container manifest support).
  return 'sales'
}
