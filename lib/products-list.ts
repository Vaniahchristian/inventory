/** Server-paginated Products page size (URL `?page=`). */
export const PRODUCTS_PAGE_SIZE = 150

export type DocumentItemsListFilters = {
  search?: string
  documentId?: string
}

export type DocumentItemsPageStats = {
  totalCount: number
  sectionCounts: {
    shipped: number
    left_in_warehouse: number
    repacked: number
  }
  totals: {
    cartons: number
    qty: number
    cbm: number
    weight: number
    amount: number
  }
}
