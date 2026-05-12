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
 * No double POST: sales files never hit the manifest API; manifest files never hit the sales API first.
 */
export async function pickSpreadsheetImportKind(file: File): Promise<'manifest' | 'sales'> {
  const name = file.name
  if (detectDocTypeFromFilename(name) === 'sales_order') {
    return 'sales'
  }
  if (filenameSuggestsContainerManifest(name)) {
    return 'manifest'
  }
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
    return 'sales'
  }
  // .xlsx / .xls / .xlsm: without MS-*/manifest in the name, keep the **existing** sales path
  // (same as before container manifest support).
  return 'sales'
}
