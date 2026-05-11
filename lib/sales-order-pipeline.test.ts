import { describe, expect, it } from 'vitest'
import { parseReductoChunks } from './reducto-html-parser'
import { resolveHtmlParserDocType } from './prompts'

describe('resolveHtmlParserDocType (sales order focus)', () => {
  it('trusts 销售单 / 送货单 filenames when chunk text has no title', () => {
    expect(resolveHtmlParserDocType('', 'export/1_销售单C707.pdf')).toBe('sales_order')
    expect(resolveHtmlParserDocType('page 2 table only', '送货单_ABC.pdf')).toBe(
      'sales_order'
    )
  })

  it('overrides sales filename when chunks clearly resemble a container manifest', () => {
    const blob =
      'SANCARGO packing list CLIENT DETAILS CONTAINER NO MSKU-1 GOODS FOR EXPORT'
    expect(resolveHtmlParserDocType(blob, '销售单_named_wrongly.pdf')).toBe(
      'container_manifest'
    )
    // Filename says sales → still sales_order if no CONTAINER NO + CLIENT/SANCARGO
    expect(resolveHtmlParserDocType('DEL NO ORD NO ITEM NO', '销售单_misc.pdf')).toBe(
      'sales_order'
    )
  })

  it('still classifies from PDF text signals when filename is neutral', () => {
    const text = [
      '送货单 DETAIL',
      'DEL NO xxx CUS NO yyy',
      'U/P AMOUNT',
      'W.H 浦江仓',
    ].join('\n')
    expect(resolveHtmlParserDocType(text, 'document.pdf')).toBe('sales_order')
  })
})

describe('parseReductoChunks sales_order HTML fixture', () => {
  /** Minimal bilingual header row scoring ≥3 mapped columns — one product line */
  function salesOrderChunkOneLine(): string {
    return `
<table><tbody>
<tr>
  <td>序号</td><td>DEL NO</td><td>ITEM NO</td><td>描述</td>
  <td>T.QTY</td><td>U/P</td><td>金额</td>
</tr>
<tr>
  <td>1</td><td>26C707-6083</td><td>WIDGET-001</td><td>Test widget desc</td>
  <td>48</td><td>12.5</td><td>600</td>
</tr>
</tbody></table>`
  }

  it('maps the numeric columns on a labelled sales-order table', () => {
    const { products, document, rowsMapped } = parseReductoChunks(
      [{ content: salesOrderChunkOneLine(), blocks: [{ type: 'table', content: '' }] }],
      'sales_order',
      { mode: 'inventory' }
    )
    expect(rowsMapped).toBeGreaterThan(0)
    expect(products.length).toBeGreaterThanOrEqual(1)

    const rows = products.filter(
      p =>
        !!String(p.source_item_no ?? p.item_code ?? '').trim() &&
        !String(p.remarks ?? '').includes('full_extract:')
    )
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const p = rows[0]!
    expect(p.source_item_no).toMatch(/WIDGET-001/i)
    expect(p.total_qty).toBe(48)
    expect(p.unit_price_rmb).toBe(12.5)
    expect(p.total_amount_rmb).toBe(600)
    expect(document.document_type).toBe('sales_order')
  })
})
