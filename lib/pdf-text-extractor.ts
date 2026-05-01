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
    const pageText = content.items
      .map((item: any) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s{3,}/g, '  ')
      .trim()
    if (pageText) pageTexts.push(pageText)
  }

  return { text: pageTexts.join('\n'), pageCount }
}
