'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { approveDocumentReview } from '@/app/actions/products'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

type ReviewDoc = {
  id: string
  document_type: 'sales_order' | 'container_manifest'
  source_file_name: string
  client_name: string | null
  container_no: string | null
  extraction_status: 'review_needed' | 'failed' | string
  extraction_confidence: number
  validation_flags: Record<string, number> | null
  created_at: string
}

export function ReviewQueueClient({ documents }: { documents: ReviewDoc[] }) {
  const [isPending, startTransition] = useTransition()

  function handleApprove(id: string) {
    startTransition(async () => {
      try {
        await approveDocumentReview(id)
        toast.success('Document approved')
      } catch (e: any) {
        toast.error(e.message ?? 'Approval failed')
      }
    })
  }

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Review Queue</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          {documents.length} document(s) require manual review or recovery
        </p>
      </div>

      <div className="rounded-md border bg-white overflow-x-auto">
        <Table className="text-xs min-w-[900px]">
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead>Type</TableHead>
              <TableHead>Source File</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Container</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Confidence</TableHead>
              <TableHead>Flags</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-24 text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-slate-400 py-10">
                  No documents in review queue.
                </TableCell>
              </TableRow>
            ) : (
              documents.map(doc => (
                <TableRow key={doc.id} className="hover:bg-slate-50">
                  <TableCell>{doc.document_type}</TableCell>
                  <TableCell className="max-w-[280px] truncate">{doc.source_file_name}</TableCell>
                  <TableCell>{doc.client_name ?? '-'}</TableCell>
                  <TableCell>{doc.container_no ?? '-'}</TableCell>
                  <TableCell>
                    <Badge variant={doc.extraction_status === 'failed' ? 'destructive' : 'outline'}>
                      {doc.extraction_status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-medium">{doc.extraction_confidence}</TableCell>
                  <TableCell className="max-w-[240px] truncate">
                    {doc.validation_flags ? JSON.stringify(doc.validation_flags) : '-'}
                  </TableCell>
                  <TableCell>{new Date(doc.created_at).toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" disabled={isPending} onClick={() => handleApprove(doc.id)}>
                      Approve
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
