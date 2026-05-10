export const dynamic = 'force-dynamic'

import { getShippedDocumentItems, getDocumentItemDocuments, getLatestImportMeta } from '@/app/actions/products'
import { CompiledProductsClient } from './compiled-client'
import type { DocumentItem } from '@/lib/types'

function mapToProduct(item: DocumentItem) {
  return {
    id: item.id,
    name: item.description ?? item.marks ?? null,
    sku: item.marks ?? null,
    source_item_no: item.source_item_no ?? item.item_code ?? null,
    description: item.description,
    supplier_id: null,
    unit: item.unit?.trim() || 'pcs',
    cost_price: item.unit_price_rmb ?? 0,
    selling_price: 0,
    quantity: item.total_quantity ?? 0,
    reorder_level: 0,
    image_url: null,
    packing: item.packaging,
    cartons: item.total_cartons,
    unit_cbm: item.unit_cbm,
    cbm: item.total_cbm,
    unit_weight: item.unit_weight_kg != null ? `${item.unit_weight_kg}KGS` : null,
    total_weight: item.total_weight_kg != null ? `${item.total_weight_kg}KGS` : null,
    total_amount_rmb: item.total_amount_rmb,
    shop_name: item.shop,
    source_document_id: item.document_id,
    source_document_item_id: item.id,
    barcode: item.barcode ?? null,
    code: null,
    warehouse: item.warehouse ?? null,
    remarks: item.remarks ?? null,
    photo: null,
    photo2: null,
    dim_l_cm: item.dim_l_cm ?? null,
    dim_w_cm: item.dim_w_cm ?? null,
    dim_h_cm: item.dim_h_cm ?? null,
    order_no: item.marks ?? null,
    customer_no: item.customer_item_ref ?? null,
    delivery_address: null,
    document_date: item.documents?.document_date ?? null,
    created_at: item.created_at,
    updated_at: item.created_at,
    suppliers: null,
  }
}

export default async function CompiledProductsPage() {
  const [itemsResult, importMetaResult, productDocumentsResult] =
    await Promise.allSettled([
      getShippedDocumentItems(),
      getLatestImportMeta(),
      getDocumentItemDocuments(),
    ])

  if (itemsResult.status === 'rejected') throw itemsResult.reason

  const items = itemsResult.value
  const products = items.map(mapToProduct)
  const importMeta = importMetaResult.status === 'fulfilled' ? importMetaResult.value : null
  const productDocuments = productDocumentsResult.status === 'fulfilled' ? productDocumentsResult.value : []

  return (
    <CompiledProductsClient
      products={products as any}
      importMeta={importMeta}
      productDocuments={productDocuments as any}
    />
  )
}
