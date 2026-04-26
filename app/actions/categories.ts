'use server'

import { revalidatePath } from 'next/cache'
import { supabase } from '@/lib/supabase'

function isTransientFetchError(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes('fetch failed') || m.includes('network') || m.includes('etimedout')
}

async function withSupabaseRetry<T>(run: () => PromiseLike<T>, label: string, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await run()
    } catch (err) {
      lastError = err
      const msg = err instanceof Error ? err.message : String(err)
      if (!isTransientFetchError(msg) || i === attempts - 1) break
      const backoffMs = 300 * (i + 1)
      console.warn(`[categories] transient error on ${label}, retry ${i + 1}/${attempts} in ${backoffMs}ms: ${msg}`)
      await new Promise(resolve => setTimeout(resolve, backoffMs))
    }
  }
  throw lastError
}

export async function getCategories() {
  const { data, error } = await withSupabaseRetry(
    () =>
      supabase
        .from('categories')
        .select('*')
        .order('name'),
    'getCategories'
  )
  if (error) throw new Error(error.message)
  return data
}

export async function createCategory(formData: FormData) {
  const name = formData.get('name') as string
  const description = formData.get('description') as string

  const { error } = await withSupabaseRetry(
    () => supabase.from('categories').insert({ name, description: description || null }),
    'createCategory'
  )
  if (error) throw new Error(error.message)
  revalidatePath('/categories')
  revalidatePath('/products')
}

export async function updateCategory(id: string, formData: FormData) {
  const name = formData.get('name') as string
  const description = formData.get('description') as string

  const { error } = await withSupabaseRetry(
    () =>
      supabase
        .from('categories')
        .update({ name, description: description || null })
        .eq('id', id),
    'updateCategory'
  )
  if (error) throw new Error(error.message)
  revalidatePath('/categories')
}

export async function deleteCategory(id: string) {
  const { error } = await withSupabaseRetry(
    () => supabase.from('categories').delete().eq('id', id),
    'deleteCategory'
  )
  if (error) throw new Error(error.message)
  revalidatePath('/categories')
  revalidatePath('/products')
}
