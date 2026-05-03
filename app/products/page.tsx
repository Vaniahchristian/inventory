export const dynamic = 'force-dynamic'

import { getDocumentItems, getDocumentItemDocuments, getLatestImportMeta } from "@/app/actions/products"
import { ProductsClient } from "./products-client"

export default async function ProductsPage() {
  const [itemsResult, docsResult, importMetaResult] = await Promise.allSettled([
    getDocumentItems(),
    getDocumentItemDocuments(),
    getLatestImportMeta(),
  ])

  if (itemsResult.status === 'rejected') {
    throw itemsResult.reason
  }

  const items = itemsResult.value
  const productDocuments = docsResult.status === 'fulfilled' ? docsResult.value : []
  const importMeta = importMetaResult.status === 'fulfilled' ? importMetaResult.value : null

  return (
    <ProductsClient
      items={items as any}
      importMeta={importMeta}
      productDocuments={productDocuments}
    />
  )
}
