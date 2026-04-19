'use server'

import { revalidatePath } from 'next/cache'
import { supabase } from '@/lib/supabase'

export async function getSuppliers() {
  const { data, error } = await supabase
    .from('suppliers')
    .select('*')
    .order('name')
  if (error) throw new Error(error.message)
  return data
}

export async function createSupplier(formData: FormData) {
  const { error } = await supabase.from('suppliers').insert({
    name: formData.get('name') as string,
    contact_name: (formData.get('contact_name') as string) || null,
    email: (formData.get('email') as string) || null,
    phone: (formData.get('phone') as string) || null,
    address: (formData.get('address') as string) || null,
  })
  if (error) throw new Error(error.message)
  revalidatePath('/suppliers')
  revalidatePath('/products')
}

export async function updateSupplier(id: string, formData: FormData) {
  const { error } = await supabase
    .from('suppliers')
    .update({
      name: formData.get('name') as string,
      contact_name: (formData.get('contact_name') as string) || null,
      email: (formData.get('email') as string) || null,
      phone: (formData.get('phone') as string) || null,
      address: (formData.get('address') as string) || null,
    })
    .eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/suppliers')
}

export async function deleteSupplier(id: string) {
  const { error } = await supabase.from('suppliers').delete().eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/suppliers')
  revalidatePath('/products')
}
