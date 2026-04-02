-- Paste the ENTIRE file into Supabase → SQL Editor → Run once.
-- Fixes: infinite recursion on timetable_members, failed timetables/events REST, share_code "获取失败".
-- Safe to re-run (idempotent policies + replace functions).

-- 1) Membership helpers: must use row_security = off or inner reads re-enter RLS.
create or replace function public.timetable_member_has_role(
  p_timetable_id uuid,
  p_roles text[] default array['owner', 'editor', 'viewer']::text[]
)
returns boolean
language sql
security definer
set search_path = public
set row_security = off
stable
as $$
  select exists (
    select 1
    from public.timetable_members tm
    where tm.timetable_id = p_timetable_id
      and tm.user_id = auth.uid()
      and tm.role = any (p_roles)
  );
$$;

create or replace function public.timetable_member_is_owner(p_timetable_id uuid)
returns boolean
language sql
security definer
set search_path = public
set row_security = off
stable
as $$
  select public.timetable_member_has_role(p_timetable_id, array['owner']::text[]);
$$;

grant execute on function public.timetable_member_has_role(uuid, text[]) to authenticated;
grant execute on function public.timetable_member_is_owner(uuid) to authenticated;

-- 2) RPC return type change (uuid → json with share_code)
drop function if exists public.create_timetable(text);
drop function if exists public.join_timetable_by_code(text);

-- 3) RLS policies (depend on helpers above)
drop policy if exists timetables_select_members on public.timetables;
create policy timetables_select_members
on public.timetables for select to authenticated
using (public.timetable_member_has_role(timetables.id));

drop policy if exists timetables_insert_owner on public.timetables;
create policy timetables_insert_owner
on public.timetables for insert to authenticated
with check (created_by = auth.uid());

drop policy if exists timetables_update_owner on public.timetables;
create policy timetables_update_owner
on public.timetables for update to authenticated
using (public.timetable_member_is_owner(timetables.id));

drop policy if exists timetable_members_select_self_or_members on public.timetable_members;
create policy timetable_members_select_self_or_members
on public.timetable_members for select to authenticated
using (
  user_id = auth.uid()
  or public.timetable_member_has_role(timetable_members.timetable_id)
);

drop policy if exists timetable_members_insert_owner on public.timetable_members;
create policy timetable_members_insert_owner
on public.timetable_members for insert to authenticated
with check (public.timetable_member_is_owner(timetable_members.timetable_id));

drop policy if exists events_select_members on public.events;
create policy events_select_members
on public.events for select to authenticated
using (public.timetable_member_has_role(events.timetable_id));

drop policy if exists events_insert_editor_or_owner on public.events;
create policy events_insert_editor_or_owner
on public.events for insert to authenticated
with check (
  public.timetable_member_has_role(events.timetable_id, array['owner', 'editor']::text[])
);

drop policy if exists events_update_editor_or_owner on public.events;
create policy events_update_editor_or_owner
on public.events for update to authenticated
using (
  public.timetable_member_has_role(events.timetable_id, array['owner', 'editor']::text[])
);

drop policy if exists events_delete_editor_or_owner on public.events;
create policy events_delete_editor_or_owner
on public.events for delete to authenticated
using (
  public.timetable_member_has_role(events.timetable_id, array['owner', 'editor']::text[])
);

-- 4) RPCs return { id, share_code }
create or replace function public.create_timetable(p_name text default '未命名日程表')
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_timetable_id uuid;
  v_share_code text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.timetables(name, created_by)
  values (coalesce(nullif(trim(p_name), ''), '未命名日程表'), auth.uid())
  returning id, share_code into v_timetable_id, v_share_code;

  insert into public.timetable_members(timetable_id, user_id, role)
  values (v_timetable_id, auth.uid(), 'owner')
  on conflict do nothing;

  return json_build_object('id', v_timetable_id, 'share_code', v_share_code);
end;
$$;

grant execute on function public.create_timetable(text) to authenticated;

create or replace function public.join_timetable_by_code(p_share_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_timetable_id uuid;
  v_share_code text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select t.id, t.share_code
  into v_timetable_id, v_share_code
  from public.timetables t
  where t.share_code = upper(trim(p_share_code))
  limit 1;

  if v_timetable_id is null then
    raise exception 'Invalid share code';
  end if;

  insert into public.timetable_members(timetable_id, user_id, role)
  values (v_timetable_id, auth.uid(), 'editor')
  on conflict (timetable_id, user_id) do nothing;

  return json_build_object('id', v_timetable_id, 'share_code', v_share_code);
end;
$$;

grant execute on function public.join_timetable_by_code(text) to authenticated;
