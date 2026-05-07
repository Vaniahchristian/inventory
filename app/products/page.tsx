export const dynamic = 'force-dynamic'

import {
  getDocumentItemsForList,
  getDocumentItemsPageStats,
  getDocumentFooterRowsForList,
  getDocumentItemDocuments,
  getLatestImportMeta,
} from '@/app/actions/products'
import type { DocumentItemsListFilters } from '@/lib/products-list'
import { ProductsClient } from './products-client'

type SearchParams = { q?: string; doc?: string }

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const q = (sp.q ?? '').trim()
  const docRaw = (sp.doc ?? '').trim()
  const doc = docRaw === '' ? 'all' : docRaw

  const filters: DocumentItemsListFilters = {
    search: q || undefined,
    documentId: doc !== 'all' ? doc : undefined,
  }

  const docOnlyFilters: DocumentItemsListFilters | null =
    doc !== 'all' ? { documentId: doc } : null

  const [
    items,
    listStats,
    footerRows,
    productDocuments,
    importMeta,
    globalStats,
    docScopeStats,
  ] = await Promise.all([
    getDocumentItemsForList(filters),
    getDocumentItemsPageStats(filters),
    getDocumentFooterRowsForList(filters),
    getDocumentItemDocuments(),
    getLatestImportMeta(),
    getDocumentItemsPageStats({}),
    docOnlyFilters ? getDocumentItemsPageStats(docOnlyFilters) : Promise.resolve(null),
  ])

  return (
    <ProductsClient
      items={items}
      importMeta={importMeta}
      productDocuments={productDocuments}
      listStats={listStats}
      globalStats={globalStats}
      docScopeStats={docScopeStats}
      footerRows={footerRows}
      initialQ={q}
      initialDoc={doc}
    />
  )
}
