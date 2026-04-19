export const dynamic = 'force-dynamic'

import { getSuppliers } from "@/app/actions/suppliers"
import { SuppliersClient } from "./suppliers-client"

export default async function SuppliersPage() {
  const suppliers = await getSuppliers()
  return <SuppliersClient suppliers={suppliers} />
}
