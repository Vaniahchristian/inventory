export const dynamic = 'force-dynamic'

import { getProducts, getLatestImportMeta } from '@/app/actions/products'
import { CompiledProductsClient } from './compiled-client'

export default async function CompiledProductsPage() {
  const [products, importMeta] = await Promise.all([
    getProducts(),
    getLatestImportMeta(),
  ])

  return <CompiledProductsClient products={products as any} importMeta={importMeta} />
}
