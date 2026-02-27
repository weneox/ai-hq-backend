-- AI HQ schema (upgrade-safe + legacy fixes)
-- 100% fix for legacy messages.conversation_id NOT NULL issues
-- Keeps data, no DROP tables

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

-- ---- Legacy rename: conversation_id -> thread_id (only if thread_id missing)
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_name = 'messages' and column_name = 'conversation_id'
  )
  and not exists (
    select 1
    from information_schema.columns
    where table_name = 'messages' and column_name = 'thread_id'
  ) then
    begin
      alter table messages rename column conversation_id to thread_id;
    exception when others then
      null;
    end;
  end if;
end$$;

-- ---- Add missing columns safely
alter table messages add column if not exists id uuid;
alter table messages add column if not exists thread_id uuid;
alter table messages add column if not exists role text;
alter table messages add column if not exists agent text;
alter table messages add column if not exists content text;
alter table messages add column if not exists meta jsonb default '{}'::jsonb;
alter table messages add column if not exists created_at timestamptz default now();

-- ---- If both exist, copy conversation_id -> thread_id where thread_id is null
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name='messages' and column_name='conversation_id'
  ) and exists (
    select 1 from information_schema.columns
    where table_name='messages' and column_name='thread_id'
  ) then
    begin
      execute 'update messages set thread_id = conversation_id where thread_id is null';
    exception when others then
      null;
    end;
  end if;
end$$;

-- ---- Ensure messages.id default uuid
do $$
begin
  begin
    alter table messages alter column id set default gen_random_uuid();
  exception when others then null;
  end;
end$$;

-- ---- Ensure thread_id NOT NULL if possible (best-effort)
do $$
begin
  begin
    alter table messages alter column thread_id set not null;
  exception when others then
    null;
  end;
end$$;

-- ---- Ensure FK on messages.thread_id (best-effort)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_thread_id_fkey') then
    begin
      alter table messages
        add constraint messages_thread_id_fkey
        foreign key (thread_id) references threads(id) on delete cascade;
    exception when others then
      null;
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
    exception when others then
      null;
    end;
  end if;
end$$;

-- ============================================================
-- ✅ HARD FIX: legacy conversation_id NOT NULL (this is your current crash)
-- If conversation_id exists, drop NOT NULL and auto-fill from thread_id
-- ============================================================

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name='messages' and column_name='conversation_id'
  ) then
    begin
      execute 'alter table messages alter column conversation_id drop not null';
    exception when others then
      null;
    end;
  end if;
end$$;

create or replace function messages_fill_conversation_id()
returns trigger as $$
begin
  -- Only act if legacy column exists
  if exists (
    select 1 from information_schema.columns
    where table_name='messages' and column_name='conversation_id'
  ) then
    if NEW.conversation_id is null then
      NEW.conversation_id := NEW.thread_id;
    end if;
  end if;

  return NEW;
end;
$$ language plpgsql;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name='messages' and column_name='conversation_id'
  ) then
    -- recreate trigger idempotently
    begin
      execute 'drop trigger if exists trg_messages_fill_conversation_id on messages';
    exception when others then
      null;
    end;

    begin
      execute 'create trigger trg_messages_fill_conversation_id
               before insert on messages
               for each row
               execute function messages_fill_conversation_id()';
    exception when others then
      null;
    end;
  end if;
end$$;