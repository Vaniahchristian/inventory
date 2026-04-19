'use server'

import { revalidatePath } from 'next/cache'
import { supabase } from '@/lib/supabase'
import type { MovementType } from '@/lib/types'

export async function getStockMovements() {
  const { data, error } = await supabase
    .from('stock_movements')
    .select('*, products(id,name,sku,unit)')
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw new Error(error.message)
  return data
}

export async function createStockMovement(formData: FormData) {
  const movement_type = formData.get('movement_type') as MovementType
  const quantity = parseInt(formData.get('quantity') as string)

  const { error } = await supabase.from('stock_movements').insert({
    product_id: formData.get('product_id') as string,
    movement_type,
    quantity,
    reference: (formData.get('reference') as string) || null,
    notes: (formData.get('notes') as string) || null,
  })
  if (error) throw new Error(error.message)
  revalidatePath('/stock')
  revalidatePath('/products')
  revalidatePath('/')
}

export async function getDashboardStats() {
  const [{ data: products }, { data: movements }] = await Promise.all([
    supabase.from('products').select('quantity, cost_price, reorder_level'),
    supabase
      .from('stock_movements')
      .select('id')
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
  ])

  const totalProducts = products?.length ?? 0
  const totalValue = products?.reduce((s, p) => s + p.quantity * p.cost_price, 0) ?? 0
  const lowStockCount = products?.filter(p => p.quantity <= p.reorder_level).length ?? 0
  const recentMovements = movements?.length ?? 0

  return { totalProducts, totalValue, lowStockCount, recentMovements }
}
