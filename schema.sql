create table if not exists public.mi_membership_orders (
  id uuid primary key default gen_random_uuid(),
  order_id text unique not null,
  plan_id text not null check (plan_id in ('gold','silver','junior','blue')),
  amount_inr integer not null check (amount_inr >= 0),
  payment_status text not null default 'PENDING' check (payment_status in ('PENDING','PAID','FAILED','CANCELLED')),
  membership_id text unique,
  customer_name text not null,
  email text not null,
  phone text not null,
  customer_details jsonb not null,
  activated_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists mi_membership_orders_phone_idx on public.mi_membership_orders(phone);
create index if not exists mi_membership_orders_email_idx on public.mi_membership_orders(email);
-- Enable RLS. The Flutter client must NOT read/write this table directly.
alter table public.mi_membership_orders enable row level security;
-- No anon/authenticated policies are intentionally created. Server uses the service-role key.
