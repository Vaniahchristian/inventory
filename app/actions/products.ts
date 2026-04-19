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
  const { error } = await supabase.from('products').insert({
    name: formData.get('name') as string,
    sku: formData.get('sku') as string,
    description: (formData.get('description') as string) || null,
    category_id: (formData.get('category_id') as string) || null,
    supplier_id: (formData.get('supplier_id') as string) || null,
    unit: (formData.get('unit') as string) || 'pcs',
    cost_price: parseFloat(formData.get('cost_price') as string) || 0,
    selling_price: parseFloat(formData.get('selling_price') as string) || 0,
    quantity: parseInt(formData.get('quantity') as string) || 0,
    reorder_level: parseInt(formData.get('reorder_level') as string) || 0,
  })
  if (error) throw new Error(error.message)
  revalidatePath('/products')
  revalidatePath('/')
}

export async function updateProduct(id: string, formData: FormData) {
  const { error } = await supabase
    .from('products')
    .update({
      name: formData.get('name') as string,
      sku: formData.get('sku') as string,
      description: (formData.get('description') as string) || null,
      category_id: (formData.get('category_id') as string) || null,
      supplier_id: (formData.get('supplier_id') as string) || null,
      unit: (formData.get('unit') as string) || 'pcs',
      cost_price: parseFloat(formData.get('cost_price') as string) || 0,
      selling_price: parseFloat(formData.get('selling_price') as string) || 0,
      reorder_level: parseInt(formData.get('reorder_level') as string) || 0,
    })
    .eq('id', id)
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

export async function importProducts(rows: Record<string, unknown>[]) {
  const mapped = rows.map(r => ({
    name: String(r['name'] ?? r['Name'] ?? ''),
    sku: String(r['sku'] ?? r['SKU'] ?? ''),
    description: String(r['description'] ?? r['Description'] ?? '') || null,
    unit: String(r['unit'] ?? r['Unit'] ?? 'pcs'),
    cost_price: parseFloat(String(r['cost_price'] ?? r['Cost Price'] ?? 0)),
    selling_price: parseFloat(String(r['selling_price'] ?? r['Selling Price'] ?? 0)),
    quantity: parseInt(String(r['quantity'] ?? r['Quantity'] ?? 0)),
    reorder_level: parseInt(String(r['reorder_level'] ?? r['Reorder Level'] ?? 0)),
  }))

  const { error } = await supabase.from('products').upsert(mapped, { onConflict: 'sku' })
  if (error) throw new Error(error.message)
  revalidatePath('/products')
  revalidatePath('/')
}
