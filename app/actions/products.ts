'use server'

import { revalidatePath } from 'next/cache'
import { supabase } from '@/lib/supabase'
import type { ImportMeta } from '@/lib/types'

/** Terminal logs when importing: dev server, or set DEBUG_PRODUCT_IMPORT=1 / NEXT_PUBLIC_DEBUG_PRODUCT_IMPORT=1 */
function importDebug(): boolean {
  return (
    process.env.NODE_ENV === 'development' ||
    process.env.DEBUG_PRODUCT_IMPORT === '1' ||
    process.env.NEXT_PUBLIC_DEBUG_PRODUCT_IMPORT === '1'
  )
}

function logImport(...args: unknown[]) {
  if (importDebug()) console.log('[product-import]', ...args)
}

export async function getProducts() {
  const { data, error } = await supabase
    .from('products')
    .select('*, categories(id,name), suppliers(id,name)')
    .order('sku', { nullsFirst: false })
  if (error) throw new Error(error.message)
  return data
}

export async function getLatestImportMeta() {
  const { data, error } = await supabase
    .from('product_import_meta')
    .select('*')
    .eq('id', 1)
    .maybeSingle()
  if (error) {
    // Metadata is optional; do not fail the products page on RLS/policy issues.
    logImport('getLatestImportMeta skipped:', error.message)
    return null
  }
  return data as ImportMeta | null
}

export async function createProduct(formData: FormData) {
  const imageFile = formData.get('image') as File | null
  let image_url: string | null = null

  if (imageFile && imageFile.size > 0) {
    const ext = imageFile.name.split('.').pop()
    const path = `${Date.now()}.${ext}`
    const { error: upErr } = await supabase.storage
      .from('product-images')
      .upload(path, imageFile, { upsert: true })
    if (!upErr) {
      const { data: pub } = supabase.storage.from('product-images').getPublicUrl(path)
      image_url = pub.publicUrl
    }
  }

  const { error } = await supabase.from('products').insert({
    name: (formData.get('name') as string) || null,
    sku: (formData.get('sku') as string) || null,
    description: (formData.get('description') as string) || null,
    category_id: (formData.get('category_id') as string) || null,
    supplier_id: (formData.get('supplier_id') as string) || null,
    unit: (formData.get('unit') as string) || 'pcs',
    shop_name: (formData.get('shop_name') as string) || null,
    packing: (formData.get('packing') as string) || null,
    cartons: intOrNull(formData.get('cartons')),
    cost_price: parseFloat(formData.get('cost_price') as string) || 0,
    selling_price: parseFloat(formData.get('selling_price') as string) || 0,
    quantity: parseInt(formData.get('quantity') as string) || 0,
    unit_cbm: numOrNull(formData.get('unit_cbm')),
    cbm: numOrNull(formData.get('cbm')),
    unit_weight: (formData.get('unit_weight') as string) || null,
    total_weight: (formData.get('total_weight') as string) || null,
    total_amount_rmb: numOrNull(formData.get('total_amount_rmb')),
    reorder_level: parseInt(formData.get('reorder_level') as string) || 0,
    image_url,
  })
  if (error) throw new Error(error.message)
  revalidatePath('/products')
  revalidatePath('/')
}

export async function updateProduct(id: string, formData: FormData) {
  const imageFile = formData.get('image') as File | null
  let image_url: string | undefined

  if (imageFile && imageFile.size > 0) {
    const ext = imageFile.name.split('.').pop()
    const path = `${Date.now()}.${ext}`
    const { error: upErr } = await supabase.storage
      .from('product-images')
      .upload(path, imageFile, { upsert: true })
    if (!upErr) {
      const { data: pub } = supabase.storage.from('product-images').getPublicUrl(path)
      image_url = pub.publicUrl
    }
  }

  const update: Record<string, unknown> = {
    name: (formData.get('name') as string) || null,
    sku: (formData.get('sku') as string) || null,
    description: (formData.get('description') as string) || null,
    category_id: (formData.get('category_id') as string) || null,
    supplier_id: (formData.get('supplier_id') as string) || null,
    unit: (formData.get('unit') as string) || 'pcs',
    shop_name: (formData.get('shop_name') as string) || null,
    packing: (formData.get('packing') as string) || null,
    cartons: intOrNull(formData.get('cartons')),
    cost_price: parseFloat(formData.get('cost_price') as string) || 0,
    selling_price: parseFloat(formData.get('selling_price') as string) || 0,
    quantity: parseInt(formData.get('quantity') as string) || 0,
    unit_cbm: numOrNull(formData.get('unit_cbm')),
    cbm: numOrNull(formData.get('cbm')),
    unit_weight: (formData.get('unit_weight') as string) || null,
    total_weight: (formData.get('total_weight') as string) || null,
    total_amount_rmb: numOrNull(formData.get('total_amount_rmb')),
    reorder_level: parseInt(formData.get('reorder_level') as string) || 0,
  }
  if (image_url !== undefined) update.image_url = image_url

  const { error } = await supabase.from('products').update(update).eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/products')
  revalidatePath('/')
}

export async function markOutOfStock(id: string) {
  const { error } = await supabase.from('products').update({ cartons: 0, quantity: 0 }).eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/products')
  revalidatePath('/')
}

export async function adjustProductCartons(id: string, delta: number) {
  const { data } = await supabase.from('products').select('cartons').eq('id', id).single()
  const current = data?.cartons ?? 0
  const next = Math.max(0, current + delta)
  const { error } = await supabase.from('products').update({ cartons: next }).eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/products')
  revalidatePath('/')
}

export async function deleteProduct(id: string) {
  const { error } = await supabase.from('products').delete().eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/products')
  revalidatePath('/')
}

export async function deleteAllProducts() {
  const { error } = await supabase.from('products').delete().not('id', 'is', null)
  if (error) throw new Error(error.message)
  await supabase.from('product_import_meta').delete().eq('id', 1)
  revalidatePath('/products')
  revalidatePath('/compiled-products')
  revalidatePath('/')
}

async function saveImportMeta(meta: ImportMeta | null | undefined) {
  if (!meta) return
  const payload = {
    id: 1,
    ...meta,
    updated_at: new Date().toISOString(),
  }
  const { error } = await supabase.from('product_import_meta').upsert(payload, { onConflict: 'id' })
  if (error) {
    // Keep import resilient when product_import_meta is protected by RLS.
    logImport('saveImportMeta skipped:', error.message)
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function pickEnglishFirst(a: string, b: string): string | null {
  const aLatin = /^[A-Za-z]/.test(a)
  const bLatin = /^[A-Za-z]/.test(b)
  if (aLatin) return a        // descGoods is English → use it
  if (bLatin) return b        // col6val is English → use it
  return a || b || null       // both Chinese or empty → take whatever exists
}

function str(v: unknown): string {
  return String(v ?? '').trim()
}

function num(v: unknown): number {
  return parseFloat(str(v).replace(/[^\d.-]/g, '')) || 0
}

function numOrNull(v: unknown): number | null {
  const n = parseFloat(str(v).replace(/[^\d.-]/g, ''))
  return isNaN(n) ? null : n
}

function intOrNull(v: unknown): number | null {
  const s = str(v).replace(/[^\d]/g, '')
  return s ? parseInt(s) : null
}

function parseUnit(packing: string): string {
  const m = packing.match(/\d+\s*([a-zA-Z]+)\s*\/\s*ctn/i)
  return m ? m[1].toLowerCase() : 'pcs'
}

/** True if col 0 of a data row looks like a valid product MARKS value */
function isValidMarks(raw: string): boolean {
  const first = raw.split('\n')[0].trim()
  if (!first) return false
  if (first.length < 3) return false
  if (/\s/.test(first)) return false
  if (/[¥￥]/.test(first)) return false
  if (/[\\/]/.test(first)) return false
  const upper = first.toUpperCase()
  return !(
    upper.includes('MARKS') ||
    upper.includes('PACKING') ||
    upper.includes('ITEM') ||
    upper.includes('SHOP') ||
    upper.includes('CLIENT DETAILS') ||
    upper.includes('CONTAINER NO') ||
    upper.includes('NEW ORDER') ||
    upper.includes('GOODS LEFT') ||
    upper.includes('GOODS BALANCE') ||
    upper.includes('TOTAL ') ||
    upper.includes('PCS') ||
    upper.includes('CTN') ||
    upper.includes('CBM') ||
    upper.includes('KGS')
  )
}

// ── import ────────────────────────────────────────────────────────────────────

export async function importProducts(rows: Record<string, unknown>[], importMeta?: ImportMeta | null) {
  const allKeys = new Set(rows.flatMap(r => Object.keys(r)))
  const isPackingList =
    allKeys.has('MARKS') || allKeys.has('T.QTY') || allKeys.has('U.PRICE (RMB)')

  logImport('importProducts: incoming rows=', rows.length, 'isPackingList=', isPackingList)
  logImport(
    'column keys (sample):',
    [...allKeys].filter(k => !k.startsWith('__col')).slice(0, 24),
    'has __col*',
    [...allKeys].some(k => k.startsWith('__col'))
  )
  if (rows[0]) {
    logImport('first raw row keys:', Object.keys(rows[0]), 'MARKS=', String(rows[0].MARKS ?? '').slice(0, 40))
  }

  let skippedInvalidMarks = 0
  const invalidMarksSamples: string[] = []
  const zeroOrBad: {
    sku: string | null
    quantity: number
    cost_price: number
    isShifted: boolean
    raw: Record<string, unknown>
  }[] = []

  type MappedRow = {
    sku: string | null
    name: string | null
    description: string | null
    shop_name: string | null
    unit: string
    packing: string | null
    cartons: number | null
    quantity: number
    unit_cbm: number | null
    cbm: number | null
    unit_weight: string | null
    total_weight: string | null
    cost_price: number
    total_amount_rmb: number | null
    selling_price: number
    reorder_level: number
  }

  const mapped: MappedRow[] = []

  for (const r of rows) {
    if (isPackingList) {
      const rawSku = str(r['MARKS'] ?? '')

      // Skip non-product rows: totals, payment lines, page headers, blank rows
      if (!isValidMarks(rawSku)) {
        skippedInvalidMarks++
        if (invalidMarksSamples.length < 10)
          invalidMarksSamples.push(String(rawSku).replace(/\n/g, '\\n').slice(0, 120))
        continue
      }

      const sku = rawSku.split('\n')[0].trim() || null

      const descGoods = str(r['DESCRIPTION OF GOODS'] ?? '')
      const col6val = str(r['__col6'] ?? '')
      const shop = str(r['SHOP#'] ?? '') || null

      // CSV conversion sometimes shifts columns when a cell is merged.
      // Detection: a valid PACKING value contains a slash (e.g. "15pcs/ctn").
      // If PACKING has no slash, the Chinese product name ended up there and
      // the real packing/qty/cbm/price columns are each shifted one to the right.
      const packingField = str(r['PACKING'] ?? '')
      const isShifted = !!packingField && !/\//.test(packingField)

      let name: string | null
      let packing: string | null
      let cartons: number | null
      let quantity: number
      let unit_cbm: number | null
      let cbm: number | null
      let unit_weight: string | null
      let total_weight: string | null
      let cost_price: number
      let total_amount_rmb: number | null

      if (isShifted) {
        // packingField actually contains the Chinese product name; real data shifts right
        name = packingField || col6val || descGoods || null
        packing = str(r['T.CTN'] ?? '') || null
        cartons = intOrNull(r['T.QTY'])
        quantity = intOrNull(r['T.CBM']) ?? 0
        unit_cbm = numOrNull(r['UNIT CBM'])
        cbm = numOrNull(r['UNIT WEIGHT'])
        unit_weight = str(r['T.WEIGHT'] ?? '') || null
        total_weight = str(r['U.PRICE (RMB)'] ?? r['U.PRICE(RMB)'] ?? '') || null
        cost_price = num(r['T.AMOUNT'])
        total_amount_rmb = numOrNull(r['__col15'] ?? r['__col14'] ?? '')
      } else {
        // Prefer whichever value starts with a Latin letter (English name over
        // Chinese-only text). If both or neither are Latin, descGoods wins.
        name = pickEnglishFirst(descGoods, col6val)
        packing = packingField || null
        cartons = intOrNull(r['T.CTN'])
        quantity = intOrNull(r['T.QTY']) ?? 0
        unit_cbm = numOrNull(r['UNIT CBM'])
        cbm = numOrNull(r['T.CBM'])
        unit_weight = str(r['UNIT WEIGHT'] ?? '') || null
        total_weight = str(r['T.WEIGHT'] ?? '') || null
        cost_price = num(r['U.PRICE (RMB)'] ?? r['U.PRICE(RMB)'] ?? '')
        total_amount_rmb = numOrNull(r['T.AMOUNT'])
      }

      mapped.push({
        sku,
        name,
        description: [descGoods, col6val].filter(Boolean).join(' – ') || null,
        shop_name: shop,
        unit: packing ? parseUnit(packing) : 'pcs',
        packing,
        cartons,
        quantity,
        unit_cbm,
        cbm,
        unit_weight,
        total_weight,
        cost_price,
        total_amount_rmb,
        selling_price: 0,
        reorder_level: 0,
      })

      if (quantity === 0 || cost_price === 0) {
        if (zeroOrBad.length < 25)
          zeroOrBad.push({
            sku,
            quantity,
            cost_price,
            isShifted,
            raw: {
              PACKING: r['PACKING'],
              'T.CTN': r['T.CTN'],
              'T.QTY': r['T.QTY'],
              'T.CBM': r['T.CBM'],
              'U.PRICE (RMB)': r['U.PRICE (RMB)'],
              'T.AMOUNT': r['T.AMOUNT'],
            },
          })
      }
    } else {
      // Standard exported format (column names from our own Excel export)
      const name = str(r['name'] ?? r['Name']) || null
      const sku = str(r['sku'] ?? r['SKU']) || null
      if (!name && !sku) continue
      mapped.push({
        sku,
        name,
        description: str(r['description'] ?? r['Description']) || null,
        shop_name: null,
        unit: str(r['unit'] ?? r['Unit']) || 'pcs',
        packing: null,
        cartons: null,
        quantity: intOrNull(r['quantity'] ?? r['Quantity']) ?? 0,
        unit_cbm: numOrNull(r['unit_cbm'] ?? r['Unit CBM']),
        cbm: null,
        unit_weight: null,
        total_weight: null,
        cost_price: num(r['cost_price'] ?? r['Cost Price']),
        total_amount_rmb: null,
        selling_price: num(r['selling_price'] ?? r['Selling Price']),
        reorder_level: intOrNull(r['reorder_level'] ?? r['Reorder Level']) ?? 0,
      })
    }
  }

  logImport(
    'mapped rows:',
    mapped.length,
    'skipped (invalid MARKS):',
    skippedInvalidMarks,
    invalidMarksSamples.length ? 'samples:' : '',
    invalidMarksSamples
  )
  if (zeroOrBad.length)
    logImport(
      'rows with quantity=0 OR cost_price=0 (first 25):',
      zeroOrBad.length,
      zeroOrBad
    )
  if (isPackingList && mapped.length && importDebug()) {
    const s = mapped[0]
    logImport('first mapped product:', {
      sku: s.sku,
      quantity: s.quantity,
      cost_price: s.cost_price,
      packing: s.packing,
      cartons: s.cartons,
    })
  }

  if (mapped.length === 0) throw new Error('No valid product rows found in file')

  // Insert every row as-is — no deduplication. Duplicate SKUs/marks from the
  // same PDF (e.g. same item in different containers or sizes) are all stored.
  const CHUNK = 50
  for (let i = 0; i < mapped.length; i += CHUNK) {
    const chunk = mapped.slice(i, i + CHUNK)
    const { error } = await supabase.from('products').insert(chunk)
    if (error) throw new Error(error.message)
  }

  await saveImportMeta(importMeta)

  revalidatePath('/products')
  revalidatePath('/')
  return mapped.length
}
