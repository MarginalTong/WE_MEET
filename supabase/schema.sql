-- Run this file in Supabase SQL Editor.
-- It creates collaboration tables, functions, indexes, and RLS policies.

create extension if not exists pgcrypto;

create table if not exists public.timetables (
  id uuid primary key default gen_random_uuid(),
  name text not null default '未命名课表',
  share_code text not null unique default upper(substr(md5(gen_random_uuid()::text), 1, 8)),
  timezone text not null default 'Asia/Shanghai',
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.timetable_members (
  timetable_id uuid not null references public.timetables(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (timetable_id, user_id)
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  timetable_id uuid not null references public.timetables(id) on delete cascade,
  day text not null check (day in ('周一', '周二', '周三', '周四', '周五', '周六', '周日')),
  start text not null check (start ~ '^([01][0-9]|2[0-4]):[0-5][0-9]$'),
  "end" text not null check ("end" ~ '^([01][0-9]|2[0-4]):[0-5][0-9]$'),
  title text,
  source text not null default 'manual',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_events_timetable_id on public.events (timetable_id);
create index if not exists idx_events_timetable_start on public.events (timetable_id, start);
create index if not exists idx_timetable_members_user_id on public.timetable_members (user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_timetables_updated_at on public.timetables;
create trigger trg_timetables_updated_at
before update on public.timetables
for each row execute function public.set_updated_at();

drop trigger if exists trg_events_updated_at on public.events;
create trigger trg_events_updated_at
before update on public.events
for each row execute function public.set_updated_at();

alter table public.timetables enable row level security;
alter table public.timetable_members enable row level security;
alter table public.events enable row level security;

drop policy if exists timetables_select_members on public.timetables;
create policy timetables_select_members
on public.timetables
for select
to authenticated
using (
  exists (
    select 1
    from public.timetable_members tm
    where tm.timetable_id = timetables.id
      and tm.user_id = auth.uid()
  )
);

drop policy if exists timetables_insert_owner on public.timetables;
create policy timetables_insert_owner
on public.timetables
for insert
to authenticated
with check (created_by = auth.uid());

drop policy if exists timetables_update_owner on public.timetables;
create policy timetables_update_owner
on public.timetables
for update
to authenticated
using (
  exists (
    select 1
    from public.timetable_members tm
    where tm.timetable_id = timetables.id
      and tm.user_id = auth.uid()
      and tm.role = 'owner'
  )
);

drop policy if exists timetable_members_select_self_or_members on public.timetable_members;
create policy timetable_members_select_self_or_members
on public.timetable_members
for select
to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1
    from public.timetable_members tm
    where tm.timetable_id = timetable_members.timetable_id
      and tm.user_id = auth.uid()
  )
);

drop policy if exists timetable_members_insert_owner on public.timetable_members;
create policy timetable_members_insert_owner
on public.timetable_members
for insert
to authenticated
with check (
  exists (
    select 1
    from public.timetable_members tm
    where tm.timetable_id = timetable_members.timetable_id
      and tm.user_id = auth.uid()
      and tm.role = 'owner'
  )
);

drop policy if exists events_select_members on public.events;
create policy events_select_members
on public.events
for select
to authenticated
using (
  exists (
    select 1
    from public.timetable_members tm
    where tm.timetable_id = events.timetable_id
      and tm.user_id = auth.uid()
  )
);

drop policy if exists events_insert_editor_or_owner on public.events;
create policy events_insert_editor_or_owner
on public.events
for insert
to authenticated
with check (
  exists (
    select 1
    from public.timetable_members tm
    where tm.timetable_id = events.timetable_id
      and tm.user_id = auth.uid()
      and tm.role in ('owner', 'editor')
  )
);

drop policy if exists events_update_editor_or_owner on public.events;
create policy events_update_editor_or_owner
on public.events
for update
to authenticated
using (
  exists (
    select 1
    from public.timetable_members tm
    where tm.timetable_id = events.timetable_id
      and tm.user_id = auth.uid()
      and tm.role in ('owner', 'editor')
  )
);

drop policy if exists events_delete_editor_or_owner on public.events;
create policy events_delete_editor_or_owner
on public.events
for delete
to authenticated
using (
  exists (
    select 1
    from public.timetable_members tm
    where tm.timetable_id = events.timetable_id
      and tm.user_id = auth.uid()
      and tm.role in ('owner', 'editor')
  )
);

create or replace function public.create_timetable(p_name text default '未命名课表')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_timetable_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.timetables(name, created_by)
  values (coalesce(nullif(trim(p_name), ''), '未命名课表'), auth.uid())
  returning id into v_timetable_id;

  insert into public.timetable_members(timetable_id, user_id, role)
  values (v_timetable_id, auth.uid(), 'owner')
  on conflict do nothing;

  return v_timetable_id;
end;
$$;

grant execute on function public.create_timetable(text) to authenticated;

create or replace function public.join_timetable_by_code(p_share_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_timetable_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select t.id
  into v_timetable_id
  from public.timetables t
  where t.share_code = upper(trim(p_share_code))
  limit 1;

  if v_timetable_id is null then
    raise exception 'Invalid share code';
  end if;

  insert into public.timetable_members(timetable_id, user_id, role)
  values (v_timetable_id, auth.uid(), 'editor')
  on conflict (timetable_id, user_id) do nothing;

  return v_timetable_id;
end;
$$;

grant execute on function public.join_timetable_by_code(text) to authenticated;

alter publication supabase_realtime add table public.events;
