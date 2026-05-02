'use client'

import { createContext, useContext, useState, useCallback, useRef } from 'react'

export type ImportStatus = 'idle' | 'importing' | 'done' | 'error'

interface ImportState {
  status: ImportStatus
  progress: number
  stage: string
  fileName: string | null
  error: string | null
}

interface ImportStore extends ImportState {
  startImport: (fileName: string) => void
  updateProgress: (pct: number, stage: string) => void
  finishImport: () => void
  failImport: (error: string) => void
}

const ImportStoreContext = createContext<ImportStore | null>(null)

export function ImportStoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ImportState>({
    status: 'idle',
    progress: 0,
    stage: '',
    fileName: null,
    error: null,
  })
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const startImport = useCallback((fileName: string) => {
    if (clearTimer.current) clearTimeout(clearTimer.current)
    setState({ status: 'importing', progress: 0, stage: 'Reading PDF…', fileName, error: null })
  }, [])

  const updateProgress = useCallback((pct: number, stage: string) => {
    setState(prev => ({ ...prev, progress: pct, stage }))
  }, [])

  const finishImport = useCallback(() => {
    setState(prev => ({ ...prev, status: 'done', progress: 100, stage: 'Complete' }))
    clearTimer.current = setTimeout(
      () => setState({ status: 'idle', progress: 0, stage: '', fileName: null, error: null }),
      4000
    )
  }, [])

  const failImport = useCallback((error: string) => {
    setState(prev => ({ ...prev, status: 'error', error }))
    clearTimer.current = setTimeout(
      () => setState({ status: 'idle', progress: 0, stage: '', fileName: null, error: null }),
      6000
    )
  }, [])

  return (
    <ImportStoreContext.Provider
      value={{ ...state, startImport, updateProgress, finishImport, failImport }}
    >
      {children}
    </ImportStoreContext.Provider>
  )
}

export function useImportStore() {
  const ctx = useContext(ImportStoreContext)
  if (!ctx) throw new Error('useImportStore must be used within ImportStoreProvider')
  return ctx
}
