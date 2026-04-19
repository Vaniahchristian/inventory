export const dynamic = 'force-dynamic'

import { getStockMovements } from "@/app/actions/stock"
import { getProducts } from "@/app/actions/products"
import { StockClient } from "./stock-client"

export default async function StockPage() {
  const [movements, products] = await Promise.all([
    getStockMovements(),
    getProducts(),
  ])

  return <StockClient movements={movements as any} products={products as any} />
}
