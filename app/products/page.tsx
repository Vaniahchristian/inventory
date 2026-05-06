export const dynamic = 'force-dynamic'

import {
  getDocumentItemsPaged,
  getDocumentItemsPageStats,
  getDocumentFooterRowsForList,
  getDocumentItemDocuments,
  getLatestImportMeta,
} from '@/app/actions/products'
import { PRODUCTS_PAGE_SIZE, type DocumentItemsListFilters } from '@/lib/products-list'
import { ProductsClient } from './products-client'

type SearchParams = { page?: string; q?: string; doc?: string }

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)
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
    paged,
    listStats,
    footerRows,
    productDocuments,
    importMeta,
    globalStats,
    docScopeStats,
  ] = await Promise.all([
    getDocumentItemsPaged({ page, pageSize: PRODUCTS_PAGE_SIZE, filters }),
    getDocumentItemsPageStats(filters),
    getDocumentFooterRowsForList(filters),
    getDocumentItemDocuments(),
    getLatestImportMeta(),
    getDocumentItemsPageStats({}),
    docOnlyFilters ? getDocumentItemsPageStats(docOnlyFilters) : Promise.resolve(null),
  ])

  return (
    <ProductsClient
      items={paged.items}
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
