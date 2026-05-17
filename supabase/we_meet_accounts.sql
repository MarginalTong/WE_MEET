-- Username + code accounts for WE_MEET (run once in Supabase SQL Editor).
-- Auth credentials live in auth.users (internal email); this table is the public username directory.

create table if not exists public.we_meet_accounts (
  username text primary key,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists idx_we_meet_accounts_user_id on public.we_meet_accounts (user_id);

alter table public.we_meet_accounts enable row level security;

drop policy if exists we_meet_accounts_select_own on public.we_meet_accounts;
create policy we_meet_accounts_select_own
on public.we_meet_accounts
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists we_meet_accounts_insert_own on public.we_meet_accounts;
create policy we_meet_accounts_insert_own
on public.we_meet_accounts
for insert
to authenticated
with check (user_id = auth.uid());
