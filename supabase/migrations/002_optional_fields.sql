-- Make name and sku optional (nullable)
ALTER TABLE products ALTER COLUMN name DROP NOT NULL;
ALTER TABLE products ALTER COLUMN sku DROP NOT NULL;

-- Add image_url column
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url text;

-- Make suppliers.name optional too
ALTER TABLE suppliers ALTER COLUMN name DROP NOT NULL;

-- Create storage bucket for product images
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images',
  'product-images',
  true,
  5242880,
  ARRAY['image/jpeg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO NOTHING;
