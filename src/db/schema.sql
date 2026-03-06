-- src/db/schema.sql
-- AI HQ schema (upgrade-safe + FULL legacy fixes) — FINAL v7.5
-- ✅ Adds/ensures: threads, messages, proposals, notifications, jobs, audit_log, push_subscriptions, tenants, content_items
-- ✅ Keeps: legacy fixes (messages/proposals conversation_id + agent_key)
-- ✅ FIX: proposals.status includes in_progress + published
-- ✅ FIX: content_items.status is FUTURE-PROOF (draft.* + asset.* + publish.* + exec statuses)
-- ✅ Safe for production: NO DROP TABLE

create extension if not exists pgcrypto;

-- ============================================================
-- shared helper: updated_at trigger fn (created once)
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'set_updated_at') then
    execute $fn$
      create or replace function set_updated_at() returns trigger as $f$
      begin
        new.updated_at = now();
        return new;
      end; $f$ language plpgsql;
    $fn$;
  end if;
exception when others then null;
end$$;

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

-- drop legacy FK to conversation_id if exists
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'messages_conversation_id_fkey') then
    begin
      execute 'alter table messages drop constraint messages_conversation_id_fkey';
    exception when others then null;
    end;
  end if;
end$$;

-- drop NOT NULL on legacy conversation_id if exists
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

-- ensure FK exists (idempotent)
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
  status text not null default 'pending',
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

-- drop legacy FK to conversation_id if exists
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'proposals_conversation_id_fkey') then
    begin
      execute 'alter table proposals drop constraint proposals_conversation_id_fkey';
    exception when others then null;
    end;
  end if;
end$$;

-- drop NOT NULL on legacy conversation_id if exists
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

-- legacy agent_key not-null fix (if exists)
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

-- backfill agent_key from agent if both exist
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

-- ✅ IMPORTANT: status constraint includes in_progress + published
do $$
begin
  begin
    execute 'alter table proposals drop constraint if exists proposals_status_check';
  exception when others then null;
  end;

  begin
    alter table proposals
      add constraint proposals_status_check
      check (status in ('pending','in_progress','approved','published','rejected'));
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
-- push_subscriptions
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

-- ============================================================
-- tenants (NEOX default)
-- ============================================================
create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  tenant_key text not null unique,
  name text not null default '',
  brand jsonb not null default '{}'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  schedule jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_tenants_key on tenants(tenant_key);

do $$
begin
  if not exists (select 1 from tenants where tenant_key='neox') then
    insert into tenants (tenant_key, name, brand, meta, schedule)
    values (
      'neox',
      'NEOX',
      '{}'::jsonb,
      jsonb_build_object(
        'pageId', '1034647199727587',
        'igUserId', '17841473956986087'
      ),
      jsonb_build_object(
        'tz', 'Asia/Baku',
        'publishHourLocal', 10,
        'publishMinuteLocal', 0
      )
    );
  end if;
exception when others then null;
end$$;

-- ============================================================
-- content_items (DRAFT + ASSET + PUBLISH lifecycle)
-- ============================================================
create table if not exists content_items (
  id uuid primary key default gen_random_uuid(),

  proposal_id uuid,
  thread_id uuid,
  job_id uuid,

  status text not null default 'draft.ready',
  version int not null default 1,
  content_pack jsonb not null default '{}'::jsonb,
  last_feedback text not null default '',

  tenant_key text not null default 'neox',
  type text not null default 'image',
  title text not null default '',
  caption text not null default '',
  hashtags text not null default '',
  media jsonb not null default '{}'::jsonb,
  schedule_at timestamptz,
  approved_at timestamptz,
  approved_by text,
  published_at timestamptz,
  publish jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ensure columns exist in older deployments (idempotent)
alter table content_items add column if not exists proposal_id uuid;
alter table content_items add column if not exists thread_id uuid;
alter table content_items add column if not exists job_id uuid;

alter table content_items add column if not exists status text;
alter table content_items add column if not exists version int;
alter table content_items add column if not exists content_pack jsonb default '{}'::jsonb;
alter table content_items add column if not exists last_feedback text;

alter table content_items add column if not exists tenant_key text;
alter table content_items add column if not exists type text;
alter table content_items add column if not exists title text;
alter table content_items add column if not exists caption text;
alter table content_items add column if not exists hashtags text;
alter table content_items add column if not exists media jsonb default '{}'::jsonb;
alter table content_items add column if not exists schedule_at timestamptz;
alter table content_items add column if not exists approved_at timestamptz;
alter table content_items add column if not exists approved_by text;
alter table content_items add column if not exists published_at timestamptz;
alter table content_items add column if not exists publish jsonb default '{}'::jsonb;

alter table content_items add column if not exists created_at timestamptz default now();
alter table content_items add column if not exists updated_at timestamptz default now();

-- defaults (best-effort)
do $$
begin
  begin
    alter table content_items alter column id set default gen_random_uuid();
  exception when others then null;
  end;
  begin
    alter table content_items alter column status set default 'draft.ready';
  exception when others then null;
  end;
  begin
    alter table content_items alter column version set default 1;
  exception when others then null;
  end;
  begin
    alter table content_items alter column content_pack set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table content_items alter column last_feedback set default '';
  exception when others then null;
  end;
  begin
    alter table content_items alter column updated_at set default now();
  exception when others then null;
  end;
end$$;

-- ✅ FUTURE-PROOF status constraint (this is the key fix)
do $$
begin
  begin
    execute 'alter table content_items drop constraint if exists content_items_status_check';
  exception when others then null;
  end;

  begin
    alter table content_items
      add constraint content_items_status_check
      check (
        -- Draft lifecycle
        status like 'draft.%'

        -- Asset generation lifecycle (support both singular/plural)
        OR status like 'asset.%'
        OR status like 'assets.%'
        OR status like 'render.%'

        -- Publish lifecycle
        OR status like 'publish.%'
        OR status in ('publishing','published')

        -- Common generic states (some backends use these)
        OR status in (
          'pending',
          'queued',
          'running',
          'in_progress',
          'completed',
          'failed',
          'approved',
          'rejected',
          'pending_approval'
        )
      );
  exception when others then null;
  end;
end$$;

-- FK (optional, idempotent)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'content_items_proposal_id_fkey') then
    begin
      alter table content_items
        add constraint content_items_proposal_id_fkey
        foreign key (proposal_id) references proposals(id) on delete set null;
    exception when others then null;
    end;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'content_items_thread_id_fkey') then
    begin
      alter table content_items
        add constraint content_items_thread_id_fkey
        foreign key (thread_id) references threads(id) on delete set null;
    exception when others then null;
    end;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'content_items_job_id_fkey') then
    begin
      alter table content_items
        add constraint content_items_job_id_fkey
        foreign key (job_id) references jobs(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;

-- indexes
create index if not exists idx_content_proposal_updated on content_items(proposal_id, updated_at desc);
create index if not exists idx_content_status_updated on content_items(status, updated_at desc);
create index if not exists idx_content_tenant_status on content_items(tenant_key, status, created_at desc);
create index if not exists idx_content_schedule on content_items(status, schedule_at);

-- auto updated_at trigger (best-effort)
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_content_items_updated_at') then
    execute '
      create trigger trg_content_items_updated_at
      before update on content_items
      for each row execute function set_updated_at();
    ';
  end if;
exception when others then null;
end$$;

-- ============================================================
-- Mojibake repair (best-effort)
-- ============================================================
do $$
begin
  begin
    update messages
      set content = convert_from(convert_to(content, 'LATIN1'), 'UTF8')
    where content is not null and content ~ 'Ã.|Â.|â€|â€™|â€œ|â€�|â€“|â€”|â€¦';
  exception when others then null;
  end;

  begin
    update proposals
      set title = convert_from(convert_to(title, 'LATIN1'), 'UTF8')
    where title is not null and title ~ 'Ã.|Â.|â€|â€™|â€œ|â€�|â€“|â€”|â€¦';
  exception when others then null;
  end;

  begin
    update notifications
      set title = convert_from(convert_to(title, 'LATIN1'), 'UTF8')
    where title is not null and title ~ 'Ã.|Â.|â€|â€™|â€œ|â€�|â€“|â€”|â€¦';
  exception when others then null;
  end;

  begin
    update notifications
      set body = convert_from(convert_to(body, 'LATIN1'), 'UTF8')
    where body is not null and body ~ 'Ã.|Â.|â€|â€™|â€œ|â€�|â€“|â€”|â€¦';
  exception when others then null;
  end;

exception when others then null;
end$$;