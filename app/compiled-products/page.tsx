export const dynamic = 'force-dynamic'

import { getProducts, getLatestImportMeta, getProductDocuments } from '@/app/actions/products'
import { getSuppliers } from '@/app/actions/suppliers'
import { CompiledProductsClient } from './compiled-client'

export default async function CompiledProductsPage() {
  const [productsResult, importMetaResult, suppliersResult, productDocumentsResult] =
    await Promise.allSettled([
      getProducts(),
      getLatestImportMeta(),
      getSuppliers(),
      getProductDocuments(),
    ])

  if (productsResult.status === 'rejected') throw productsResult.reason
  const products = productsResult.value
  const importMeta = importMetaResult.status === 'fulfilled' ? importMetaResult.value : null
  const suppliers = suppliersResult.status === 'fulfilled' ? suppliersResult.value : []
  const productDocuments = productDocumentsResult.status === 'fulfilled' ? productDocumentsResult.value : []

  return (
    <CompiledProductsClient
      products={products as any}
      importMeta={importMeta}
      suppliers={suppliers as any}
      productDocuments={productDocuments as any}
    />
  )
}
