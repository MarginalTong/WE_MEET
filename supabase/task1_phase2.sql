-- Run in Supabase SQL Editor once, after task1_security.sql.
-- Adds columns needed for browser-side Supabase session bridging.

alter table public.task1_users
  add column if not exists supabase_user_id uuid,
  add column if not exists supabase_password_b64 text;
