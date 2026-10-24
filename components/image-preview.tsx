'use client'

import { useState, type ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

function uniqUrls(...candidates: (string | null | undefined)[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of candidates) {
    const u = (raw ?? '').trim()
    if (!u || seen.has(u)) continue
    seen.add(u)
    out.push(u)
  }
  return out
}

/** Full-size lightbox for one or more image URLs. */
export function ImagePreviewDialog({
  urls,
  open,
  onOpenChange,
  title = 'Photo preview',
  initialIndex = 0,
}: {
  urls: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  initialIndex?: number
}) {
  const list = urls.filter(Boolean)
  const [index, setIndex] = useState(initialIndex)
  const active = list[Math.min(Math.max(index, 0), Math.max(list.length - 1, 0))] ?? null

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (next) setIndex(initialIndex)
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="sm:max-w-3xl p-3 bg-slate-950 text-white ring-slate-700"
        showCloseButton
      >
        <DialogHeader className="px-1">
          <DialogTitle className="text-sm font-medium text-slate-100">{title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          <div className="relative flex max-h-[min(75vh,720px)] w-full items-center justify-center overflow-hidden rounded-lg bg-black/40">
            {active ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={active}
                alt=""
                className="max-h-[min(75vh,720px)] max-w-full object-contain"
              />
            ) : (
              <p className="text-sm text-slate-400 py-16">No image</p>
            )}
          </div>
          {list.length > 1 && (
            <div className="flex items-center gap-2">
              {list.map((u, i) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setIndex(i)}
                  className={cn(
                    'h-12 w-12 overflow-hidden rounded border-2 transition-colors',
                    i === index ? 'border-white' : 'border-transparent opacity-60 hover:opacity-100'
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={u} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

type ThumbProps = {
  url?: string | null
  /** Extra URLs shown in the lightbox (e.g. photo2). */
  extraUrls?: (string | null | undefined)[]
  alt?: string
  className?: string
  imgClassName?: string
  size?: 'sm' | 'md' | 'lg'
  title?: string
  empty?: ReactNode
  stopPropagation?: boolean
}

const sizeClass = {
  sm: 'h-8 w-8',
  md: 'h-9 w-9',
  lg: 'h-10 w-10',
} as const

/**
 * Thumbnail that opens an in-app preview dialog on click
 * (instead of navigating to the raw image URL).
 */
export function ImagePreviewThumb({
  url,
  extraUrls = [],
  alt = '',
  className,
  imgClassName,
  size = 'md',
  title = 'Photo preview',
  empty,
  stopPropagation = true,
}: ThumbProps) {
  const [open, setOpen] = useState(false)
  const urls = uniqUrls(url, ...extraUrls)

  if (urls.length === 0) {
    return (
      empty ?? (
        <div
          className={cn(sizeClass[size], 'rounded bg-slate-100 border border-slate-200', className)}
          aria-hidden
        />
      )
    )
  }

  const thumb = urls[0]!

  return (
    <>
      <button
        type="button"
        title="Click to preview"
        className={cn(
          sizeClass[size],
          'block shrink-0 overflow-hidden rounded border border-slate-200 bg-white p-0 cursor-zoom-in hover:ring-2 hover:ring-indigo-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400',
          className
        )}
        onClick={e => {
          if (stopPropagation) {
            e.preventDefault()
            e.stopPropagation()
          }
          setOpen(true)
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumb}
          alt={alt}
          className={cn('h-full w-full object-cover', imgClassName)}
          loading="lazy"
        />
      </button>
      <ImagePreviewDialog
        urls={urls}
        open={open}
        onOpenChange={setOpen}
        title={title}
      />
    </>
  )
}
