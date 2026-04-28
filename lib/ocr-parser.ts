// Parses OCR output from SANCARGO packing lists and 销售单 sales orders.
//
// Two OCR formats appear in the same document:
//   Format A – MARKS on its own line, then "SANCARGO [shop] [item] [desc] [numbers...]" on one line
//   Format B – MARKS on its own line, bare "SANCARGO" on the next, data spread across subsequent lines
//
// Both formats are handled by parsePackingListLines(), which detects the format per-row.

function cleanSpaces(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

// A MARKS token is a product code like MS-311-1, 37-T-120-10, BL6015W1.
// It must contain at least one Latin letter AND either a digit or a dash.
// Pure-letter words (shop names like "flinra") and pure numbers are NOT marks tokens.
function isMarksToken(token: string): boolean {
  const t = (token ?? '').trim()
  if (t.length < 3 || t.includes(' ')) return false
  if (/^[\d.]+$/.test(t)) return false
  const upper = t.toUpperCase()
  const blocked = new Set([
    'MARKS', 'PACKING', 'ITEM', 'SHOP', 'CLIENT', 'CONTAINER', 'TOTAL', 'GOODS',
    'CBM', 'KGS', 'CTN', 'PCS', 'SANCARGO', 'DESCRIPTION', 'UNIT', 'WEIGHT',
    'PRICE', 'AMOUNT', 'QUANTITY', 'DATE', 'QTY', 'SETS', 'NOS', 'PRS',
  ])
  if (blocked.has(upper)) return false
  if (!/[A-Za-z]/.test(t)) return false
  // Shop names are pure letters (e.g. "flinra"); MARKS have digits or dashes
  return /\d/.test(t) || t.includes('-')
}

// Split "shop [item_no] description" text into its parts.
// Item numbers are 1–2 digit standalone tokens (items 1–99).
// Shop codes with embedded numbers like "柔妃49348" or "49371天丽" use 4–5 digit numbers
// that will not match the 1–2 digit rule.
function parseTextPrefix(text: string): { shop: string; itemNo: string; desc: string } {
  if (!text) return { shop: '', itemNo: '', desc: '' }
  const tokens = text.split(/\s+/).filter(Boolean)
  let itemNoIdx = -1
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (/^\d{1,2}$/.test(t)) { itemNoIdx = i; break }  // standalone 1–2 digit item number
    if (/^\d+\+\d+$/.test(t)) { itemNoIdx = i; break }  // compound e.g. "9+20"
  }
  if (itemNoIdx === -1) return { shop: tokens.join(' '), itemNo: '', desc: '' }
  return {
    shop: tokens.slice(0, itemNoIdx).join(' '),
    itemNo: tokens[itemNoIdx],
    desc: tokens.slice(itemNoIdx + 1).join(' '),
  }
}

// Parse the content string (everything after "SANCARGO ") for one product row.
// Used for both Format A (direct data line) and Format B (joined block lines).
function parseSancargoContent(marks: string, content: string): Record<string, string> | null {
  if (!content.trim()) return null

  // PACKING: "16pcs/ctn", "120pcs/ctn" etc.
  const packingMatch = content.match(/\d+\s*[a-z]+\s*\/\s*ctn/i)
  const packing = packingMatch ? packingMatch[0].replace(/\s/g, '').toLowerCase() : ''

  // T.CTN: "7CTNS", "1CTNS", "0CTNS"
  const tctnMatch = content.match(/(\d+)\s*CTNS?/i)
  const tctn = tctnMatch ? `${tctnMatch[1]}CTNS` : ''
  const tctnNum = parseInt(tctnMatch?.[1] ?? '0', 10)

  // T.QTY: "7pcs", "120pcs" — negative lookahead skips "120pcs" inside "120pcs/ctn"
  const tqtyMatch = content.match(/(\d+)\s*(pcs|sets|nos|prs)(?!\s*\/\s*ctn)/i)
  const tqty = tqtyMatch ? `${tqtyMatch[1]}${tqtyMatch[2]}` : ''
  const tqtyNum = parseInt(tqtyMatch?.[1] ?? '0', 10)

  // CBM values — first = UNIT CBM, second = T.CBM
  const cbmMatches = [...content.matchAll(/\d+\.?\d*\s*CBM/gi)]
    .map(m => m[0].replace(/\s/g, '').toUpperCase())

  // KGS values — first = UNIT WEIGHT, second = T.WEIGHT
  const kgsMatches = [...content.matchAll(/\d+\.?\d*\s*KGS/gi)]
    .map(m => m[0].replace(/\s/g, '').toUpperCase())

  // Price values — second-to-last = U.PRICE, last = T.AMOUNT
  // When only one price is present it is U.PRICE (T.AMOUNT left blank)
  const priceMatches = [...content.matchAll(/[¥￥][\d,]+(?:\.\d+)?/g)].map(m => m[0])
  const unitPrice = priceMatches.length >= 2
    ? priceMatches[priceMatches.length - 2]
    : (priceMatches[0] ?? '')
  const totalAmount = priceMatches.length >= 2 ? priceMatches[priceMatches.length - 1] : ''

  // Infer packing from T.QTY ÷ T.CTN when it is not written explicitly
  // e.g. "1CTNS 120pcs" → "120pcs/ctn"
  let finalPacking = packing
  const packingWasInferred = !packing && tctnNum > 0 && tqtyNum > 0
  if (packingWasInferred) {
    finalPacking = `${Math.round(tqtyNum / tctnNum)}pcs/ctn`
  }

  // Find where numeric data starts to isolate the text prefix (shop + item + description)
  const positions: number[] = []
  if (packingMatch) positions.push(content.indexOf(packingMatch[0]))
  if (tctnMatch) positions.push(content.indexOf(tctnMatch[0]))
  const cbmStart = content.search(/\d+\.?\d*\s*CBM/i)
  if (cbmStart >= 0) positions.push(cbmStart)
  const cutoff = positions.length > 0 ? Math.min(...positions) : content.length

  const { shop, itemNo, desc } = parseTextPrefix(content.slice(0, cutoff).trim())

  // Also flag when packing was inferred rather than explicitly written —
  // non-standard column arrangement raises the risk of other fields being shifted.
  const needsLlm = !finalPacking || !tqty || !unitPrice || !cbmMatches[0] || packingWasInferred

  return {
    'MARKS': `${marks}\nSANCARGO`,
    'SHOP#': shop,
    'ITEM NO.': itemNo,
    'DESCRIPTION OF GOODS': desc,
    '__col6': '',
    'PACKING': finalPacking,
    'T.CTN': tctn,
    'T.QTY': tqty,
    'UNIT CBM': cbmMatches[0] ?? '',
    'T.CBM': cbmMatches[1] ?? cbmMatches[0] ?? '',
    'UNIT WEIGHT': kgsMatches[0] ?? '',
    'T.WEIGHT': kgsMatches[1] ?? kgsMatches[0] ?? '',
    'U.PRICE (RMB)': unitPrice,
    'T.AMOUNT': totalAmount,
    '__needs_llm': String(needsLlm),
  }
}

// Main packing list parser. Scans for lines starting with SANCARGO and decides
// which format each row uses:
//   Format A: "SANCARGO shop item desc numbers..." on one line → parse content directly
//   Format B: bare "SANCARGO" → join subsequent lines into one content string, then parse
function parsePackingListLines(lines: string[]): Record<string, string>[] {
  const rows: Record<string, string>[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]

    if (/^SANCARGO\s*$/i.test(line)) {
      // Format B: bare SANCARGO
      const marks = lines[i - 1]
      if (!isMarksToken(marks)) continue

      // Collect lines until the next MARKS token or SANCARGO line
      const blockLines: string[] = []
      let j = i + 1
      while (j < lines.length && !isMarksToken(lines[j]) && !/^SANCARGO\b/i.test(lines[j])) {
        blockLines.push(lines[j])
        j++
      }

      const combined = blockLines.join(' ').trim()
      if (!combined) continue
      const row = parseSancargoContent(marks, combined)
      if (row) rows.push(row)

    } else if (/^SANCARGO\s+\S/i.test(line)) {
      // Format A: SANCARGO + all data on the same line
      const marks = lines[i - 1]
      if (!isMarksToken(marks)) continue

      const content = line.replace(/^SANCARGO\s*/i, '').trim()
      const row = parseSancargoContent(marks, content)
      if (row) rows.push(row)
    }
  }

  return rows
}

function isSalesOrderLines(lines: string[]): boolean {
  const blob = cleanSpaces(lines.join(' ')).toLowerCase()
  return (
    blob.includes('销售单') ||
    (blob.includes('no.') && blob.includes('u/p') && blob.includes('amount') && blob.includes('t.qty')) ||
    (blob.includes('序号') && blob.includes('总箱数') && blob.includes('单价'))
  )
}

function parseSalesOrderLines(lines: string[]): Record<string, string>[] {
  const cleanLines = lines
    .map(cleanSpaces)
    .filter(x => x && !/^--\s*\d+\s+of\s+\d+\s*--$/i.test(x))

  const starts: number[] = []
  for (let i = 0; i < cleanLines.length; i++) {
    if (/^\d+\s+\d{4}-\d{2}-\d{2}$/.test(cleanLines[i])) starts.push(i)
  }
  if (!starts.length) return []

  const out: Record<string, string>[] = []
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]
    const end = i + 1 < starts.length ? starts[i + 1] : cleanLines.length
    const joined = cleanSpaces(cleanLines.slice(start, end).join(' '))
    if (!joined) continue

    const metricsMatch = joined.match(
      /(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+([A-Za-z0-9]{8,})\s+(\S+)$/i,
    )
    if (!metricsMatch) continue

    const [, ctn, qtyPerCtn, totalQty, unitPrice, amount, l, w, h, unitCbm, unitGw, totalCbm, totalKgs, barcode, warehouse] = metricsMatch
    const prefix = cleanSpaces(joined.slice(0, metricsMatch.index))
    const orderMatch = prefix.match(/C\d{2,}-\d+/i)
    const orderNo = orderMatch ? orderMatch[0] : ''
    const codes = [...prefix.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[-/][A-Za-z0-9]+)+\b/g)].map(m => m[0])
    let itemCode = ''
    for (const code of codes) {
      if (code.toUpperCase() !== orderNo.toUpperCase()) { itemCode = code; break }
    }
    const descSource = itemCode ? cleanSpaces(prefix.replace(itemCode, '')) : prefix

    out.push({
      'MARKS': itemCode || `SO-${start}`,
      'SHOP#': warehouse,
      'ITEM NO.': orderNo,
      'DESCRIPTION OF GOODS': descSource || itemCode || orderNo,
      '__col6': `barcode:${barcode} dims:${l}x${w}x${h}`,
      'PACKING': `${qtyPerCtn}pcs/ctn`,
      'T.CTN': `${ctn}CTNS`,
      'T.QTY': `${totalQty}pcs`,
      'UNIT CBM': `${unitCbm}CBM`,
      'T.CBM': `${totalCbm}CBM`,
      'UNIT WEIGHT': `${unitGw}KGS`,
      'T.WEIGHT': `${totalKgs}KGS`,
      'U.PRICE (RMB)': `¥${unitPrice}`,
      'T.AMOUNT': `¥${amount}`,
      '__needs_llm': 'false',
    })
  }
  return out
}

export function linesToRows(lines: string[]): Record<string, string>[] {
  const cleanLines = lines.map(cleanSpaces).filter(Boolean)

  // SANCARGO packing list (Format A and/or Format B)
  if (cleanLines.some(l => /^SANCARGO\b/i.test(l))) {
    const packingRows = parsePackingListLines(cleanLines)
    if (packingRows.length) return packingRows
  }

  // 销售单 sales order
  if (isSalesOrderLines(cleanLines)) {
    const salesRows = parseSalesOrderLines(cleanLines)
    if (salesRows.length) return salesRows
  }

  return []
}
