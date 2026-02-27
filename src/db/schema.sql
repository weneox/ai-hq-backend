-- AI HQ schema (idempotent)

create extension if not exists pgcrypto;

create table if not exists threads (
  id uuid primary key default gen_random_uuid(),
  title text,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references threads(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  agent text,
  content text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_thread_created on messages(thread_id, created_at);

create table if not exists proposals (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid references threads(id) on delete set null,
  agent text not null,
  type text not null default 'generic',
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  title text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decision_by text
);

create index if not exists idx_proposals_status_created on proposals(status, created_at desc);