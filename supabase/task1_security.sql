-- INFO2222 Task 1 password auth + E2EE message storage
-- Run in Supabase SQL editor once.

create extension if not exists pgcrypto;

create table if not exists public.task1_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_algorithm text not null,
  password_iterations integer not null,
  password_salt_b64 text not null,
  password_hash_b64 text not null,
  e2ee_public_key text not null,
  signing_public_key text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.task1_messages (
  id uuid primary key default gen_random_uuid(),
  "from" text not null,
  "to" text not null,
  envelope_json jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_task1_messages_to_created
on public.task1_messages ("to", created_at);
