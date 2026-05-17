-- Run in Supabase SQL Editor once, after task1_phase2.sql.
-- Lets the task1 server look up an auth.users row by email via service-role RPC.

create or replace function public.get_auth_user_id_by_email(p_email text)
returns uuid
language sql
security definer
set search_path = auth
as $$
  select id from auth.users where email = p_email limit 1;
$$;

grant execute on function public.get_auth_user_id_by_email(text) to service_role;
