/**
 * Fix 1 (infrastructure): Deterministic HTML table expander.
 *
 * Converts an HTML <table> into a 2D string array, correctly propagating
 * rowspan and colspan merged cells. A cell with rowspan=3 appears in the
 * same column of rows 0, 1, and 2 — which is exactly the behaviour we need
 * for MARKS cells that span multiple product sub-rows.
 */

export function expandHtmlTable(tableHtml: string): string[][] {
  const rowMatches = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
  if (rowMatches.length === 0) return []

  const grid: Record<string, string> = {}
  let totalRows = 0
  let maxCol = 0

  for (let logicalRow = 0; logicalRow < rowMatches.length; logicalRow++) {
    const rowHtml = rowMatches[logicalRow][1]
    let logicalCol = 0

    const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    for (const cellMatch of cells) {
      while (grid[`${logicalRow},${logicalCol}`] !== undefined) logicalCol++

      const cellTag = cellMatch[0]
      const innerHtml = cellMatch[1]

      const rowspan = parseInt(cellTag.match(/rowspan="(\d+)"/i)?.[1] ?? '1')
      const colspan = parseInt(cellTag.match(/colspan="(\d+)"/i)?.[1] ?? '1')
      const value = htmlToText(innerHtml)

      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          grid[`${logicalRow + dr},${logicalCol + dc}`] = value
          if (logicalCol + dc > maxCol) maxCol = logicalCol + dc
        }
      }

      logicalCol += colspan
    }
    totalRows = logicalRow + 1
  }

  const result: string[][] = []
  for (let r = 0; r < totalRows; r++) {
    const row: string[] = []
    for (let c = 0; c <= maxCol; c++) {
      row.push(grid[`${r},${c}`] ?? '')
    }
    result.push(row)
  }
  return result
}

export function htmlToText(html: string): string {
  // Use a sentinel to mark <br/> positions before stripping all tags.
  // We then rejoin fragments with context-aware spacing: if the previous
  // fragment ends with a letter and the next fragment is 1-2 lowercase
  // characters, join without a space (word wrapped mid-syllable by column
  // width — e.g. "Bakewar" + "e" → "Bakeware", "displ" + "ay" → "display").
  const BR = '\x00'
  const withMarkers = html.replace(/<br\s*\/?>/gi, BR)
  const plain = withMarkers
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))

  const fragments = plain.split(BR).map(f => f.replace(/\s+/g, ' ').trim())
  let result = ''
  for (const frag of fragments) {
    if (!frag) continue
    if (!result) {
      result = frag
      continue
    }
    // Word-continuation heuristic: previous fragment ends with a letter and
    // the next fragment is 1-2 lowercase characters — treat as mid-word wrap.
    const prevEndsLetter = /[a-zA-Z]$/.test(result)
    const nextIsContinuation = /^[a-z]{1,2}$/.test(frag)
    result = prevEndsLetter && nextIsContinuation ? result + frag : result + ' ' + frag
  }
  return result.replace(/\s+/g, ' ').trim()
}
