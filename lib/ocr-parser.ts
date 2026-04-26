// Port of ocr_backend/parser.py — parses OCR text lines into product rows.

function cleanSpaces(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

function isMarksToken(token: string): boolean {
  const t = (token ?? '').trim()
  if (t.length < 3) return false
  if (t.includes(' ')) return false
  const upper = t.toUpperCase()
  const bad = ['MARKS', 'PACKING', 'ITEM', 'SHOP', 'CLIENT', 'CONTAINER', 'TOTAL', 'GOODS', 'CBM', 'KGS', 'CTN', 'PCS']
  return !bad.some(b => upper.includes(b))
}

function parseLineToRow(line: string): Record<string, string> | null {
  line = cleanSpaces(line)
  if (!line) return null
  if (!line.toUpperCase().includes('SANCARGO')) return null

  const marksMatch = line.match(/^\s*([^\s]+)\s+SANCARGO\b/i)
  if (!marksMatch) return null
  const marks = marksMatch[1].trim()
  if (!isMarksToken(marks)) return null

  const packingMatch = line.match(/(\d+\s*[A-Za-z]+\s*\/\s*ctn)/i)
  if (!packingMatch) return null
  const packing = cleanSpaces(packingMatch[1]).replace(/\s/g, '')

  const tctnMatch = line.match(/(\d+)\s*CTNS?/i)
  const tqtyMatch = line.match(/(\d+)\s*(pcs|sets|nos|prs)/i)
  const cbmMatches = [...line.matchAll(/(\d+\.?\d*)\s*CBM/gi)].map(m => m[1])
  const kgsMatches = [...line.matchAll(/(\d+\.?\d*)\s*KGS/gi)].map(m => m[1])
  const priceMatches = [...line.matchAll(/[¥￥]\s*([\d,]+(?:\.\d+)?)/g)].map(m => m[1])

  return {
    'MARKS': `${marks}\nSANCARGO`,
    'SHOP#': '',
    'ITEM NO.': '',
    'DESCRIPTION OF GOODS': '',
    '__col6': '',
    'PACKING': packing,
    'T.CTN': tctnMatch ? `${tctnMatch[1]}CTNS` : '',
    'T.QTY': tqtyMatch ? `${tqtyMatch[1]}${tqtyMatch[2]}` : '',
    'UNIT CBM': cbmMatches.length >= 2 ? `${cbmMatches[0]}CBM` : '',
    'T.CBM': cbmMatches.length >= 2 ? `${cbmMatches[1]}CBM` : (cbmMatches[0] ? `${cbmMatches[0]}CBM` : ''),
    'UNIT WEIGHT': kgsMatches[0] ? `${kgsMatches[0]}KGS` : '',
    'T.WEIGHT': kgsMatches.length >= 2 ? `${kgsMatches[1]}KGS` : (kgsMatches[0] ? `${kgsMatches[0]}KGS` : ''),
    'U.PRICE (RMB)': priceMatches[0] ? `¥${priceMatches[0]}` : '',
    'T.AMOUNT': priceMatches[1] ? `¥${priceMatches[1]}` : '',
  }
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
    })
  }
  return out
}

export function linesToRows(lines: string[]): Record<string, string>[] {
  if (isSalesOrderLines(lines)) {
    const salesRows = parseSalesOrderLines(lines)
    if (salesRows.length) return salesRows
  }
  return lines.map(parseLineToRow).filter((r): r is Record<string, string> => r !== null)
}
