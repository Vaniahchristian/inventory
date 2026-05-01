'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { deleteReviewDocument, finalizeDocumentPublish, getReviewDocumentItems } from '@/app/actions/products'
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

type ReviewItem = {
  id: string
  line_no: number
  item_code: string | null
  description: string | null
  packaging: string | null
  total_cartons: number | null
  total_quantity: number | null
  unit_price_rmb: number | null
  total_amount_rmb: number | null
  validation_flags: string[]
  review_status: 'pending' | 'accepted' | 'rejected'
  model_source: string | null
  rerun_count: number
}

type ReviewDetail = {
  document: { id: string; source_file_name: string; extraction_status: string }
  gate: {
    rowParityMatch: boolean
    totalsMatch: boolean
    hasBlockingFlags: boolean
    counts: { accepted: number; total: number }
  }
  items: ReviewItem[]
}

export function ReviewQueueClient({ documents }: { documents: ReviewDoc[] }) {
  const [isPending, startTransition] = useTransition()
  const [activeDocId, setActiveDocId] = useState<string | null>(null)
  const [detailByDoc, setDetailByDoc] = useState<Record<string, ReviewDetail>>({})

  function loadDetails(id: string) {
    startTransition(async () => {
      try {
        const detail = await getReviewDocumentItems(id)
        setDetailByDoc(prev => ({ ...prev, [id]: detail as ReviewDetail }))
        setActiveDocId(id)
      } catch (e: any) {
        toast.error(e.message ?? 'Failed to load review rows')
      }
    })
  }

  function handlePushToProducts(id: string) {
    const detail = detailByDoc[id]
    if (detail) {
      const { gate } = detail
      const failures: string[] = []
      if (!gate.totalsMatch) failures.push('totals do not reconcile with row sums')
      if (gate.hasBlockingFlags) failures.push('one or more rows have blocking validation flags')
      if (!gate.rowParityMatch) failures.push('row count mismatch')
      if (failures.length > 0) {
        const ok = window.confirm(
          `Gate check failed:\n• ${failures.join('\n• ')}\n\nPublish anyway?`
        )
        if (!ok) return
      }
    }
    startTransition(async () => {
      try {
        const result = await finalizeDocumentPublish(id)
        toast.success(`Pushed ${result.publishedCount} row(s) to products`)
        if (activeDocId === id) loadDetails(id)
      } catch (e: any) {
        toast.error(e.message ?? 'Push to products failed')
      }
    })
  }

  function handleDeleteDocument(id: string) {
    if (!confirm('Delete this review document and its published products? This cannot be undone.')) return
    startTransition(async () => {
      try {
        await deleteReviewDocument(id)
        toast.success('Review document deleted')
        if (activeDocId === id) setActiveDocId(null)
      } catch (e: any) {
        toast.error(e.message ?? 'Delete failed')
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
                    <div className="flex items-center gap-2 justify-end">
                      <Button size="sm" variant="outline" disabled={isPending} onClick={() => loadDetails(doc.id)}>
                        Review Rows
                      </Button>
                      <Button size="sm" variant="destructive" disabled={isPending} onClick={() => handleDeleteDocument(doc.id)}>
                        Delete
                      </Button>
                      <Button size="sm" disabled={isPending} onClick={() => handlePushToProducts(doc.id)}>
                        Push to Products
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {activeDocId && detailByDoc[activeDocId] && (
        <div className="rounded-md border bg-white p-3 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-sm font-semibold">Row Review — {detailByDoc[activeDocId].document.source_file_name}</h2>
            <Badge variant={detailByDoc[activeDocId].gate.rowParityMatch ? 'outline' : 'destructive'}>
              Row parity: {detailByDoc[activeDocId].gate.rowParityMatch ? 'OK' : 'Mismatch'}
            </Badge>
            <Badge variant={detailByDoc[activeDocId].gate.totalsMatch ? 'outline' : 'destructive'}>
              Totals: {detailByDoc[activeDocId].gate.totalsMatch ? 'Match' : 'Mismatch'}
            </Badge>
            <Badge variant={detailByDoc[activeDocId].gate.hasBlockingFlags ? 'destructive' : 'outline'}>
              Blocking flags: {detailByDoc[activeDocId].gate.hasBlockingFlags ? 'Yes' : 'No'}
            </Badge>
            <span className="text-xs text-slate-500 ml-auto">
              Accepted {detailByDoc[activeDocId].gate.counts.accepted}/{detailByDoc[activeDocId].gate.counts.total}
            </span>
          </div>

          <div className="rounded-md border overflow-x-auto">
            <Table className="text-xs min-w-[1200px]">
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead>#</TableHead>
                  <TableHead>Item Code</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Packing</TableHead>
                  <TableHead className="text-right">CTN</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit Price</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Flags</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Model</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detailByDoc[activeDocId].items.map(row => (
                  <TableRow key={row.id}>
                    <TableCell>{row.line_no}</TableCell>
                    <TableCell>{row.item_code ?? '-'}</TableCell>
                    <TableCell className="max-w-[220px] truncate">{row.description ?? '-'}</TableCell>
                    <TableCell>{row.packaging ?? '-'}</TableCell>
                    <TableCell className="text-right">{row.total_cartons ?? '-'}</TableCell>
                    <TableCell className="text-right">{row.total_quantity ?? '-'}</TableCell>
                    <TableCell className="text-right">{row.unit_price_rmb ?? '-'}</TableCell>
                    <TableCell className="text-right">{row.total_amount_rmb ?? '-'}</TableCell>
                    <TableCell className="max-w-[260px] truncate">{row.validation_flags.join(', ') || '-'}</TableCell>
                    <TableCell>
                      <Badge variant={row.review_status === 'accepted' ? 'outline' : row.review_status === 'rejected' ? 'destructive' : 'secondary'}>
                        {row.review_status}
                      </Badge>
                    </TableCell>
                    <TableCell>{row.model_source ?? '-'} ({row.rerun_count})</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  )
}
