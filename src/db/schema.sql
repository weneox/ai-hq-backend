-- AI HQ schema (upgrade-safe + FULL legacy fixes) — FINAL v4
-- Safe for production: no DROP TABLE.
-- Fixes legacy:
--   - messages.conversation_id NOT NULL + FK
--   - proposals.conversation_id NOT NULL + FK
--   - proposals.agent_key NOT NULL (old schema)  ✅
--   - ensures uuid defaults for id columns
--   - ensures thread_id columns and best-effort FKs

create extension if not exists pgcrypto;

-- ============================================================
-- threads
-- ============================================================
create table if not exists threads (
  id uuid primary key default gen_random_uuid(),
  title text,
  created_at timestamptz not null default now()
);

-- Ensure legacy threads.id has default
do $$
begin
  begin
    alter table threads alter column id set default gen_random_uuid();
  exception when others then null;
  end;
end$$;

-- ============================================================
-- messages
-- ============================================================
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references threads(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  agent text,
  content text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Add missing columns safely (legacy upgrades)
alter table messages add column if not exists id uuid;
alter table messages add column if not exists thread_id uuid;
alter table messages add column if not exists role text;
alter table messages add column if not exists agent text;
alter table messages add column if not exists content text;
alter table messages add column if not exists meta jsonb default '{}'::jsonb;
alter table messages add column if not exists created_at timestamptz default now();

-- Drop legacy FK that references messages.conversation_id (if exists)
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'messages_conversation_id_fkey') then
    begin
      execute 'alter table messages drop constraint messages_conversation_id_fkey';
    exception when others then null;
    end;
  end if;
end$$;

-- If messages.conversation_id exists, drop NOT NULL so inserts won't fail
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name='messages' and column_name='conversation_id'
  ) then
    begin
      execute 'alter table messages alter column conversation_id drop not null';
    exception when others then null;
    end;
  end if;
end$$;

-- Ensure messages.id default uuid
do $$
begin
  begin
    alter table messages alter column id set default gen_random_uuid();
  exception when others then null;
  end;
end$$;

-- Ensure thread_id NOT NULL if possible (best-effort)
do $$
begin
  begin
    alter table messages alter column thread_id set not null;
  exception when others then null;
  end;
end$$;

-- Ensure FK on messages.thread_id (best-effort)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_thread_id_fkey') then
    begin
      alter table messages
        add constraint messages_thread_id_fkey
        foreign key (thread_id) references threads(id) on delete cascade;
    exception when others then null;
    end;
  end if;
end$$;

create index if not exists idx_messages_thread_created on messages(thread_id, created_at);

-- ============================================================
-- proposals
-- ============================================================
create table if not exists proposals (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid,
  agent text not null,
  type text not null default 'generic',
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  title text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decision_by text
);

-- Legacy upgrades for proposals
alter table proposals add column if not exists id uuid;
alter table proposals add column if not exists thread_id uuid;
alter table proposals add column if not exists agent text;
alter table proposals add column if not exists type text;
alter table proposals add column if not exists status text;
alter table proposals add column if not exists title text;
alter table proposals add column if not exists payload jsonb default '{}'::jsonb;
alter table proposals add column if not exists created_at timestamptz default now();
alter table proposals add column if not exists decided_at timestamptz;
alter table proposals add column if not exists decision_by text;

-- ✅ LEGACY FIX (CRITICAL):
-- Drop legacy FK on proposals.conversation_id (if exists)
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'proposals_conversation_id_fkey') then
    begin
      execute 'alter table proposals drop constraint proposals_conversation_id_fkey';
    exception when others then null;
    end;
  end if;
end$$;

-- ✅ LEGACY FIX (CRITICAL):
-- If proposals.conversation_id exists, drop NOT NULL so inserts won't fail
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name='proposals' and column_name='conversation_id'
  ) then
    begin
      execute 'alter table proposals alter column conversation_id drop not null';
    exception when others then null;
    end;
  end if;
end$$;

-- ✅ LEGACY FIX (CRITICAL):
-- If proposals.agent_key exists, drop NOT NULL so inserts won't fail
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name='proposals' and column_name='agent_key'
  ) then
    begin
      execute 'alter table proposals alter column agent_key drop not null';
    exception when others then null;
    end;
  end if;
end$$;

-- (Optional but useful) If proposals.agent_key exists and agent exists, backfill agent_key where null
do $$
begin
  if exists (
    select 1 from information_schema.columns where table_name='proposals' and column_name='agent_key'
  ) and exists (
    select 1 from information_schema.columns where table_name='proposals' and column_name='agent'
  ) then
    begin
      execute 'update proposals set agent_key = agent where agent_key is null and agent is not null';
    exception when others then null;
    end;
  end if;
end$$;

-- Ensure proposals.id default uuid
do $$
begin
  begin
    alter table proposals alter column id set default gen_random_uuid();
  exception when others then null;
  end;
end$$;

create index if not exists idx_proposals_status_created on proposals(status, created_at desc);

-- Optional FK for proposals.thread_id (best-effort)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'proposals_thread_id_fkey') then
    begin
      alter table proposals
        add constraint proposals_thread_id_fkey
        foreign key (thread_id) references threads(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;