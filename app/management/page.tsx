export const dynamic = 'force-dynamic'

import {
  getDocumentImportMeta,
  getDocumentItemDocuments,
  getDocumentItemsForList,
} from '@/app/actions/products'
import { ManagementClient } from './management-client'

type SearchParams = { doc?: string }

export default async function ManagementPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const documents = await getDocumentItemDocuments()

  const docRaw = (sp.doc ?? '').trim()
  const selectedDocumentId =
    docRaw && documents.some(d => d.id === docRaw)
      ? docRaw
      : (documents[0]?.id ?? null)

  const [items, footerBundle] = selectedDocumentId
    ? await Promise.all([
        getDocumentItemsForList({ documentId: selectedDocumentId }),
        getDocumentImportMeta(selectedDocumentId),
      ])
    : [[], null]

  return (
    <div className="h-[calc(100dvh-3.25rem)] md:h-dvh">
      <ManagementClient
        documents={documents}
        items={items}
        selectedDocumentId={selectedDocumentId}
        importMeta={footerBundle?.meta ?? null}
      />
    </div>
  )
}
