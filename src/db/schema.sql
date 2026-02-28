-- AI HQ schema (upgrade-safe + FULL legacy fixes) — FINAL v6
-- ✅ Adds: notifications, jobs, audit_log, push_subscriptions
-- ✅ Keeps: legacy fixes (messages/proposals conversation_id + agent_key)
-- Safe for production: no DROP TABLE.

create extension if not exists pgcrypto;

-- ============================================================
-- threads
-- ============================================================
create table if not exists threads (
  id uuid primary key default gen_random_uuid(),
  title text,
  created_at timestamptz not null default now()
);

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

alter table messages add column if not exists id uuid;
alter table messages add column if not exists thread_id uuid;
alter table messages add column if not exists role text;
alter table messages add column if not exists agent text;
alter table messages add column if not exists content text;
alter table messages add column if not exists meta jsonb default '{}'::jsonb;
alter table messages add column if not exists created_at timestamptz default now();

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'messages_conversation_id_fkey') then
    begin
      execute 'alter table messages drop constraint messages_conversation_id_fkey';
    exception when others then null;
    end;
  end if;
end$$;

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

do $$
begin
  begin
    alter table messages alter column id set default gen_random_uuid();
  exception when others then null;
  end;
end$$;

do $$
begin
  begin
    alter table messages alter column thread_id set not null;
  exception when others then null;
  end;
end$$;

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

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'proposals_conversation_id_fkey') then
    begin
      execute 'alter table proposals drop constraint proposals_conversation_id_fkey';
    exception when others then null;
    end;
  end if;
end$$;

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

do $$
begin
  begin
    alter table proposals alter column id set default gen_random_uuid();
  exception when others then null;
  end;
end$$;

create index if not exists idx_proposals_status_created on proposals(status, created_at desc);

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

-- ============================================================
-- notifications
-- ============================================================
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  recipient text not null default 'ceo',
  type text not null default 'info',
  title text not null default '',
  body text not null default '',
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

alter table notifications add column if not exists id uuid;
alter table notifications add column if not exists recipient text;
alter table notifications add column if not exists type text;
alter table notifications add column if not exists title text;
alter table notifications add column if not exists body text;
alter table notifications add column if not exists payload jsonb default '{}'::jsonb;
alter table notifications add column if not exists read_at timestamptz;
alter table notifications add column if not exists created_at timestamptz default now();

do $$
begin
  begin
    alter table notifications alter column id set default gen_random_uuid();
  exception when others then null;
  end;
end$$;

create index if not exists idx_notifications_recipient_created on notifications(recipient, created_at desc);
create index if not exists idx_notifications_unread on notifications(recipient) where read_at is null;

-- ============================================================
-- jobs
-- ============================================================
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid,
  type text not null default 'generic',
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

alter table jobs add column if not exists id uuid;
alter table jobs add column if not exists proposal_id uuid;
alter table jobs add column if not exists type text;
alter table jobs add column if not exists status text;
alter table jobs add column if not exists input jsonb default '{}'::jsonb;
alter table jobs add column if not exists output jsonb default '{}'::jsonb;
alter table jobs add column if not exists error text;
alter table jobs add column if not exists created_at timestamptz default now();
alter table jobs add column if not exists started_at timestamptz;
alter table jobs add column if not exists finished_at timestamptz;

do $$
begin
  begin
    alter table jobs alter column id set default gen_random_uuid();
  exception when others then null;
  end;
end$$;

create index if not exists idx_jobs_status_created on jobs(status, created_at desc);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_proposal_id_fkey') then
    begin
      alter table jobs
        add constraint jobs_proposal_id_fkey
        foreign key (proposal_id) references proposals(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;

-- ============================================================
-- audit_log
-- ============================================================
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  actor text not null default 'system',
  action text not null,
  object_type text not null default 'unknown',
  object_id text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table audit_log add column if not exists id uuid;
alter table audit_log add column if not exists actor text;
alter table audit_log add column if not exists action text;
alter table audit_log add column if not exists object_type text;
alter table audit_log add column if not exists object_id text;
alter table audit_log add column if not exists meta jsonb default '{}'::jsonb;
alter table audit_log add column if not exists created_at timestamptz default now();

do $$
begin
  begin
    alter table audit_log alter column id set default gen_random_uuid();
  exception when others then null;
  end;
end$$;

create index if not exists idx_audit_created on audit_log(created_at desc);
create index if not exists idx_audit_action on audit_log(action, created_at desc);

-- ============================================================
-- ✅ push_subscriptions (PWA push to your phone)
-- ============================================================
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  recipient text not null default 'ceo',
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

alter table push_subscriptions add column if not exists id uuid;
alter table push_subscriptions add column if not exists recipient text;
alter table push_subscriptions add column if not exists endpoint text;
alter table push_subscriptions add column if not exists p256dh text;
alter table push_subscriptions add column if not exists auth text;
alter table push_subscriptions add column if not exists user_agent text;
alter table push_subscriptions add column if not exists created_at timestamptz default now();
alter table push_subscriptions add column if not exists last_seen_at timestamptz;

create unique index if not exists uq_push_endpoint on push_subscriptions(endpoint);
create index if not exists idx_push_recipient on push_subscriptions(recipient, created_at desc);