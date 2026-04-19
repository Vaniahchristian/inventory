'use client'

import { useState, useCallback } from 'react'

export function useDisclosure(initial = false) {
  const [isOpen, setIsOpen] = useState(initial)
  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])
  const toggle = useCallback(() => setIsOpen(v => !v), [])
  return { isOpen, open, close, toggle }
}

export function useFilter<T extends Record<string, unknown>>(items: T[], keys: (keyof T)[]) {
  const [query, setQuery] = useState('')

  const filtered = query
    ? items.filter(item =>
        keys.some(k => String(item[k] ?? '').toLowerCase().includes(query.toLowerCase()))
      )
    : items

  return { query, setQuery, filtered }
}
