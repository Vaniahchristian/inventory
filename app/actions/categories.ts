'use server'

import { revalidatePath } from 'next/cache'
import { supabase } from '@/lib/supabase'

export async function getCategories() {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .order('name')
  if (error) throw new Error(error.message)
  return data
}

export async function createCategory(formData: FormData) {
  const name = formData.get('name') as string
  const description = formData.get('description') as string

  const { error } = await supabase.from('categories').insert({ name, description: description || null })
  if (error) throw new Error(error.message)
  revalidatePath('/categories')
  revalidatePath('/products')
}

export async function updateCategory(id: string, formData: FormData) {
  const name = formData.get('name') as string
  const description = formData.get('description') as string

  const { error } = await supabase
    .from('categories')
    .update({ name, description: description || null })
    .eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/categories')
}

export async function deleteCategory(id: string) {
  const { error } = await supabase.from('categories').delete().eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/categories')
  revalidatePath('/products')
}
