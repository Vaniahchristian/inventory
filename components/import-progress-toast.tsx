'use client'

import { useImportStore } from '@/lib/import-store'
import { Loader2, CheckCircle2, XCircle, FileText } from 'lucide-react'

export function ImportProgressToast() {
  const { status, progress, stage, fileName, error } = useImportStore()

  if (status === 'idle') return null

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 rounded-lg border shadow-lg bg-white text-sm overflow-hidden">
      {/* colour strip at top */}
      <div
        className={`h-1 transition-all duration-500 ${
          status === 'error'
            ? 'bg-red-500 w-full'
            : status === 'done'
            ? 'bg-green-500 w-full'
            : 'bg-blue-500'
        }`}
        style={status === 'importing' ? { width: `${progress}%` } : undefined}
      />

      <div className="p-3 space-y-1">
        <div className="flex items-center gap-2">
          {status === 'importing' && (
            <Loader2 className="h-4 w-4 text-blue-500 animate-spin shrink-0" />
          )}
          {status === 'done' && (
            <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
          )}
          {status === 'error' && (
            <XCircle className="h-4 w-4 text-red-500 shrink-0" />
          )}
          <span className="font-medium truncate flex-1">
            {status === 'error' ? 'Import failed' : status === 'done' ? 'Import complete' : 'Importing PDF…'}
          </span>
          {status === 'importing' && (
            <span className="text-xs text-slate-400 font-mono shrink-0">{progress}%</span>
          )}
        </div>

        {fileName && (
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <FileText className="h-3 w-3 shrink-0" />
            <span className="truncate">{fileName}</span>
          </div>
        )}

        {status === 'error' && error && (
          <p className="text-xs text-red-600 line-clamp-2">{error}</p>
        )}

        {status === 'importing' && stage && (
          <p className="text-xs text-slate-500">{stage}</p>
        )}
      </div>
    </div>
  )
}
