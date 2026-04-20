export type Category = {
  id: string
  name: string
  description: string | null
  created_at: string
}

export type Supplier = {
  id: string
  name: string
  contact_name: string | null
  email: string | null
  phone: string | null
  address: string | null
  created_at: string
}

export type Product = {
  id: string
  name: string | null
  sku: string | null
  description: string | null
  category_id: string | null
  supplier_id: string | null
  unit: string
  cost_price: number
  selling_price: number
  quantity: number
  reorder_level: number
  image_url: string | null
  packing: string | null
  cartons: number | null
  unit_cbm: number | null
  cbm: number | null
  unit_weight: string | null
  total_weight: string | null
  total_amount_rmb: number | null
  shop_name: string | null
  created_at: string
  updated_at: string
  categories?: Category | null
  suppliers?: Supplier | null
}

export type MovementType = 'in' | 'out' | 'adjustment'

export type StockMovement = {
  id: string
  product_id: string
  movement_type: MovementType
  quantity: number
  reference: string | null
  notes: string | null
  created_at: string
  products?: Pick<Product, 'id' | 'name' | 'sku' | 'unit'> | null
}

export type DashboardStats = {
  totalProducts: number
  totalValue: number
  lowStockCount: number
  recentMovements: number
}
