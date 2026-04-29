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
  source_item_no?: string | null
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
  source_document_id?: string | null
  source_document_item_id?: string | null
  barcode?: string | null
  code?: string | null
  warehouse?: string | null
  remarks?: string | null
  photo?: string | null
  photo2?: string | null
  dim_l_cm?: number | null
  dim_w_cm?: number | null
  dim_h_cm?: number | null
  order_no?: string | null
  customer_no?: string | null
  delivery_address?: string | null
  document_date?: string | null
  created_at: string
  updated_at: string
  categories?: Category | null
  suppliers?: Supplier | null
}

export type ProductDocumentRef = {
  id: string
  source_file_name: string | null
  document_type: 'sales_order' | 'container_manifest'
  created_at: string
}

export type ImportMeta = {
  source_file_name: string
  source_file_type: 'pdf' | 'excel_or_csv'
  document_type?: 'sales_order' | 'container_manifest'
  client_details: string | null
  container_no: string | null
  total_weight_kgs: number | null
  total_cbm: number | null
  total_carton: number | null
  total_cost_rmb: number | null
  total_cost_usd: number | null
  payment_date: string | null
  payment_usd: number | null
  goods_balance_usd: number | null
  credit_support_usd: number | null
  pivoc_usd: number | null
  freight_usd: number | null
  total_balance_usd: number | null
  exchange_rate: number | null
}

export type ImportDocumentMeta = {
  document_ref: string | null
  client_details: string | null
  container_no: string | null
  total_weight_text: string | null
  total_cbm_text: string | null
  total_carton_text: string | null
  total_cost_text: string | null
  goods_balance_text: string | null
  credit_support_text: string | null
  pivoc_text: string | null
  freight_text: string | null
  total_balance_text: string | null
  exchange_rate_text: string | null
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
