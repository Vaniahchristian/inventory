'use server'

import { revalidatePath } from 'next/cache'
import { supabase } from '@/lib/supabase'

export async function getProducts() {
  const { data, error } = await supabase
    .from('products')
    .select('*, categories(id,name), suppliers(id,name)')
    .order('name')
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

function str(v: unknown): string {
  return String(v ?? '').trim()
}

function num(v: unknown): number {
  // Strip currency symbols, commas, spaces and any non-numeric prefix chars
  return parseFloat(str(v).replace(/[^\d.-]/g, '')) || 0
}

function qty(v: unknown): number {
  return parseInt(str(v).replace(/[^\d]/g, '')) || 0
}

function parseUnit(packing: string): string {
  const m = packing.match(/\d+\s*([a-zA-Z]+)\s*\/\s*ctn/i)
  return m ? m[1].toLowerCase() : 'pcs'
}

export async function importProducts(rows: Record<string, unknown>[]) {
  // Detect format by scanning column keys across all rows
  const allKeys = new Set(rows.flatMap(r => Object.keys(r)))
  const isPackingList =
    allKeys.has('MARKS') ||
    allKeys.has('T.QTY') ||
    allKeys.has('U.PRICE (RMB)') ||
    allKeys.has('ITEM NO.')

  const mapped = rows.map(r => {
    if (isPackingList) {
      // CSV has "ITEM NO." with a newline in the header → stored as "ITEM NO."
      // Column 6 (index 6) has no header — it's the unnamed Chinese product name column
      // We reconstruct by checking unnamed/empty headers
      const rawSku = str(r['MARKS'] ?? '')
      const skuMatch = rawSku.match(/([A-Z]{2}-[A-Z]-\d+(?:-\d+)?)/)
      const sku = skuMatch ? skuMatch[1] : rawSku.split('\n')[0].trim() || null

      const descGoods = str(r['DESCRIPTION OF GOODS'] ?? '')
      // Column 6 (between DESCRIPTION OF GOODS and PACKING) holds the specific product name.
      // Our parser names unnamed headers __colN where N is the 0-based column index.
      const col6 = str(r['__col6'] ?? r['__col3'] ?? r['__col4'] ?? '')

      const name = col6 || descGoods || null
      const packing = str(r['PACKING'] ?? '')

      return {
        sku: sku || null,
        name,
        description: [descGoods, col6].filter(Boolean).join(' – ') || null,
        unit: parseUnit(packing),
        quantity: qty(r['T.QTY']),
        cost_price: num(r['U.PRICE (RMB)'] ?? r['U.PRICE(RMB)'] ?? r['U.PRICE (RMB) ']),
        selling_price: 0,
        reorder_level: 0,
      }
    }

    // Standard exported format
    return {
      name: str(r['name'] ?? r['Name']) || null,
      sku: str(r['sku'] ?? r['SKU']) || null,
      description: str(r['description'] ?? r['Description']) || null,
      unit: str(r['unit'] ?? r['Unit']) || 'pcs',
      cost_price: num(r['cost_price'] ?? r['Cost Price']),
      selling_price: num(r['selling_price'] ?? r['Selling Price']),
      quantity: qty(r['quantity'] ?? r['Quantity']),
      reorder_level: qty(r['reorder_level'] ?? r['Reorder Level']),
    }
  }).filter(r => r.name || r.sku)

  if (mapped.length === 0) throw new Error('No valid rows found in file')

  // Rows with SKU → upsert; rows without SKU → insert
  const withSku = mapped.filter(r => r.sku)
  const withoutSku = mapped.filter(r => !r.sku)

  if (withSku.length > 0) {
    const { error } = await supabase.from('products').upsert(withSku, { onConflict: 'sku' })
    if (error) throw new Error(error.message)
  }
  if (withoutSku.length > 0) {
    const { error } = await supabase.from('products').insert(withoutSku)
    if (error) throw new Error(error.message)
  }

  revalidatePath('/products')
  revalidatePath('/')
  return mapped.length
}
