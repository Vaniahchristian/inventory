export const dynamic = 'force-dynamic'

import { getReviewDocuments } from '@/app/actions/products'
import { ReviewQueueClient } from './review-queue-client'

export default async function ReviewQueuePage() {
  const docs = await getReviewDocuments()
  return <ReviewQueueClient documents={docs as any[]} />
}
