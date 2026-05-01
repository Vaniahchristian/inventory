'use client'

/** Extract all text from a PDF file using pdfjs-dist (runs in the browser, < 1 s). */
export async function extractPdfText(file: File): Promise<{ text: string; pageCount: number }> {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
  const pageCount = pdf.numPages

  const pageTexts: string[] = []
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const lines: string[] = []
    let currentLine = ''
    let lastY: number | null = null

    for (const item of content.items as any[]) {
      if (!('str' in item)) continue
      const y = item.transform?.[5] ?? null
      // New line when y-coordinate changes significantly (>2pt) or pdfjs flags EOL
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        if (currentLine.trim()) lines.push(currentLine.trim())
        currentLine = ''
      }
      currentLine += item.str
      if (item.hasEOL) {
        if (currentLine.trim()) lines.push(currentLine.trim())
        currentLine = ''
        lastY = null
      } else {
        lastY = y
      }
    }
    if (currentLine.trim()) lines.push(currentLine.trim())
    if (lines.length) pageTexts.push(lines.join('\n'))
  }

  return { text: pageTexts.join('\n'), pageCount }
}
