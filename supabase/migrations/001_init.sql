-- Categories
create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  created_at timestamptz default now()
);

-- Suppliers
create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_name text,
  email text,
  phone text,
  address text,
  created_at timestamptz default now()
);

-- Products
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sku text not null unique,
  description text,
  category_id uuid references categories(id) on delete set null,
  supplier_id uuid references suppliers(id) on delete set null,
  unit text not null default 'pcs',
  cost_price numeric(12,2) not null default 0,
  selling_price numeric(12,2) not null default 0,
  quantity integer not null default 0,
  reorder_level integer not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Stock movements
create table if not exists stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  movement_type text not null check (movement_type in ('in', 'out', 'adjustment')),
  quantity integer not null,
  reference text,
  notes text,
  created_at timestamptz default now()
);

-- Auto-update products.updated_at
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger products_updated_at
  before update on products
  for each row execute function update_updated_at();

-- Auto-adjust product quantity on stock movement
create or replace function adjust_product_quantity()
returns trigger language plpgsql as $$
begin
  if new.movement_type = 'in' then
    update products set quantity = quantity + new.quantity where id = new.product_id;
  elsif new.movement_type = 'out' then
    update products set quantity = quantity - new.quantity where id = new.product_id;
  elsif new.movement_type = 'adjustment' then
    update products set quantity = new.quantity where id = new.product_id;
  end if;
  return new;
end;
$$;

create trigger stock_movement_adjust
  after insert on stock_movements
  for each row execute function adjust_product_quantity();

-- Enable RLS (disable for now, enable per your auth setup)
alter table categories enable row level security;
alter table suppliers enable row level security;
alter table products enable row level security;
alter table stock_movements enable row level security;

-- Open policies (change when you add auth)
create policy "Allow all" on categories for all using (true) with check (true);
create policy "Allow all" on suppliers for all using (true) with check (true);
create policy "Allow all" on products for all using (true) with check (true);
create policy "Allow all" on stock_movements for all using (true) with check (true);
