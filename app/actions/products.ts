'use server'

import { revalidatePath } from 'next/cache'
import { supabase } from '@/lib/supabase'

export async function getProducts() {
  const { data, error } = await supabase
    .from('products')
    .select('*, categories(id,name), suppliers(id,name)')
    .order('sku', { nullsFirst: false })
  if (error) throw new Error(error.message)
  return data
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
    cost_price: parseFloat(formData.get('cost_price') as string) || 0,
    selling_price: parseFloat(formData.get('selling_price') as string) || 0,
    quantity: parseInt(formData.get('quantity') as string) || 0,
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
    cost_price: parseFloat(formData.get('cost_price') as string) || 0,
    selling_price: parseFloat(formData.get('selling_price') as string) || 0,
    reorder_level: parseInt(formData.get('reorder_level') as string) || 0,
  }
  if (image_url !== undefined) update.image_url = image_url

  const { error } = await supabase.from('products').update(update).eq('id', id)
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

// ── helpers ──────────────────────────────────────────────────────────────────

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
  return /^[A-Z]{2,3}-[A-Z]-\d/.test(raw.split('\n')[0].trim())
}

// ── import ────────────────────────────────────────────────────────────────────

export async function importProducts(rows: Record<string, unknown>[]) {
  const allKeys = new Set(rows.flatMap(r => Object.keys(r)))
  const isPackingList =
    allKeys.has('MARKS') || allKeys.has('T.QTY') || allKeys.has('U.PRICE (RMB)')

  type MappedRow = {
    sku: string | null
    name: string | null
    description: string | null
    shop_name: string | null
    unit: string
    packing: string | null
    cartons: number | null
    quantity: number
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
      if (!isValidMarks(rawSku)) continue

      const skuMatch = rawSku.match(/([A-Z]{2,3}-[A-Z]-\d+(?:-\d+)*)/)
      const sku = skuMatch ? skuMatch[1] : rawSku.split('\n')[0].trim() || null

      const descGoods = str(r['DESCRIPTION OF GOODS'] ?? '')
      // Column __col6 (index 6) holds the specific product name in most rows.
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
        cbm = numOrNull(r['UNIT WEIGHT'])
        unit_weight = str(r['T.WEIGHT'] ?? '') || null
        total_weight = str(r['U.PRICE (RMB)'] ?? r['U.PRICE(RMB)'] ?? '') || null
        cost_price = num(r['T.AMOUNT'])
        total_amount_rmb = numOrNull(r['__col15'] ?? r['__col14'] ?? '')
      } else {
        name = col6val || descGoods || null
        packing = packingField || null
        cartons = intOrNull(r['T.CTN'])
        quantity = intOrNull(r['T.QTY']) ?? 0
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
        cbm,
        unit_weight,
        total_weight,
        cost_price,
        total_amount_rmb,
        selling_price: 0,
        reorder_level: 0,
      })
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

  if (mapped.length === 0) throw new Error('No valid product rows found in file')

  // Deduplicate by SKU — later rows in the file win (last-write-wins per batch)
  const skuMap = new Map<string, MappedRow>()
  const withoutSku: MappedRow[] = []
  for (const row of mapped) {
    if (row.sku) skuMap.set(row.sku, row)
    else withoutSku.push(row)
  }
  const withSku = Array.from(skuMap.values())

  // Batch upserts in chunks of 50 to stay within Supabase request limits
  const CHUNK = 50
  for (let i = 0; i < withSku.length; i += CHUNK) {
    const chunk = withSku.slice(i, i + CHUNK)
    const { error } = await supabase.from('products').upsert(chunk, { onConflict: 'sku' })
    if (error) throw new Error(error.message)
  }
  for (let i = 0; i < withoutSku.length; i += CHUNK) {
    const chunk = withoutSku.slice(i, i + CHUNK)
    const { error } = await supabase.from('products').insert(chunk)
    if (error) throw new Error(error.message)
  }

  revalidatePath('/products')
  revalidatePath('/')
  return skuMap.size + withoutSku.length
}
