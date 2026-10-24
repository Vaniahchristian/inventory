'use client'

import { useEffect, useState } from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { ImagePreviewThumb } from '@/components/image-preview'

type SlotProps = {
  name: 'photo' | 'photo2'
  label: string
  currentUrl?: string | null
}

function PhotoSlot({ name, label, currentUrl }: SlotProps) {
  const [preview, setPreview] = useState<string | null>(null)
  const [cleared, setCleared] = useState(false)
  const [fileKey, setFileKey] = useState(0)

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview)
    }
  }, [preview])

  const shown = cleared ? null : preview ?? currentUrl ?? null

  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-slate-600 block">{label}</Label>
      <div className="flex items-start gap-3">
        <div className="h-16 w-16 shrink-0 flex items-center justify-center">
          {shown ? (
            <ImagePreviewThumb
              url={shown}
              size="lg"
              className="h-16 w-16"
              title={label}
            />
          ) : (
            <div className="h-16 w-16 rounded border border-slate-200 bg-slate-50 flex items-center justify-center">
              <span className="text-[10px] text-slate-400">None</span>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <Input
            key={fileKey}
            name={cleared ? undefined : name}
            type="file"
            accept="image/*"
            className="h-8 text-xs"
            onChange={e => {
              const f = e.target.files?.[0]
              if (preview) URL.revokeObjectURL(preview)
              setCleared(false)
              setPreview(f ? URL.createObjectURL(f) : null)
            }}
          />
          {cleared ? (
            <input type="hidden" name={`clear_${name}`} value="1" />
          ) : shown ? (
            <button
              type="button"
              className="text-[11px] text-red-600 hover:underline"
              onClick={() => {
                if (preview) URL.revokeObjectURL(preview)
                setPreview(null)
                setCleared(true)
                setFileKey(k => k + 1)
              }}
            >
              Remove photo
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function DocumentItemPhotoFields({
  photo,
  photo2,
}: {
  photo?: string | null
  photo2?: string | null
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-md border border-slate-200 bg-slate-50/60 p-3">
      <PhotoSlot name="photo" label="Photo" currentUrl={photo} />
      <PhotoSlot name="photo2" label="Photo 2" currentUrl={photo2} />
    </div>
  )
}
