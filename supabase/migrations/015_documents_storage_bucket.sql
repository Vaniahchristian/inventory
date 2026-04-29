-- Storage bucket for large PDF import staging (browser -> storage -> OCR route URL).
-- This avoids sending large file bodies through Vercel serverless functions.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents',
  'documents',
  true,
  52428800, -- 50 MB
  array['application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Keep policy style aligned with the rest of this project ("allow all").
drop policy if exists "Allow all documents storage select" on storage.objects;
create policy "Allow all documents storage select"
on storage.objects for select
using (bucket_id = 'documents');

drop policy if exists "Allow all documents storage insert" on storage.objects;
create policy "Allow all documents storage insert"
on storage.objects for insert
with check (bucket_id = 'documents');

drop policy if exists "Allow all documents storage update" on storage.objects;
create policy "Allow all documents storage update"
on storage.objects for update
using (bucket_id = 'documents')
with check (bucket_id = 'documents');

drop policy if exists "Allow all documents storage delete" on storage.objects;
create policy "Allow all documents storage delete"
on storage.objects for delete
using (bucket_id = 'documents');
