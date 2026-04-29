import { put } from '@vercel/blob'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const form = await req.formData()
  const file = form.get('file')

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file' }, { status: 400 })
  }

  const name = file.name.toLowerCase()
  const isPdf = name.endsWith('.pdf')
  const isImage = name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg')
  if (!isPdf && !isImage) {
    return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })
  }

  const blob = await put(file.name, file, { access: 'public', addRandomSuffix: true })

  return NextResponse.json({ url: blob.url, pathname: blob.pathname })
}
