-- src/db/schema.sql
-- FINAL v8.0 — AI HQ schema (upgrade-safe + inbox/operator flow hardened)
-- Key updates:
-- ✅ inbox_threads has real handoff columns
-- ✅ tenant-safe unique index for external thread ids
-- ✅ no duplicate trigger creation blocks
-- ✅ tenant inbox policy supports suppressAiDuringHandoff + autoReleaseOnOperatorReply
-- ✅ keeps legacy fixes and prior production-safe upgrades

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
  inbox_policy jsonb not null default '{}'::jsonb,
  timezone text not null default 'Asia/Baku',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenants add column if not exists brand jsonb default '{}'::jsonb;
alter table tenants add column if not exists meta jsonb default '{}'::jsonb;
alter table tenants add column if not exists schedule jsonb default '{}'::jsonb;
alter table tenants add column if not exists inbox_policy jsonb default '{}'::jsonb;
alter table tenants add column if not exists timezone text default 'Asia/Baku';
alter table tenants add column if not exists updated_at timestamptz default now();

create index if not exists idx_tenants_key on tenants(tenant_key);

do $$
begin
  if not exists (select 1 from tenants where tenant_key='neox') then
    insert into tenants (tenant_key, name, brand, meta, schedule, inbox_policy, timezone)
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
      ),
      jsonb_build_object(
        'autoReplyEnabled', true,
        'createLeadEnabled', true,
        'handoffEnabled', true,
        'markSeenEnabled', true,
        'typingIndicatorEnabled', true,
        'suppressAiDuringHandoff', true,
        'autoReleaseOnOperatorReply', false,
        'allowedChannels', jsonb_build_array('instagram','facebook','whatsapp'),
        'quietHoursEnabled', false,
        'quietHoursStart', 0,
        'quietHoursEnd', 0,
        'humanKeywords', jsonb_build_array(
          'operator','menecer','manager','human',
          'adamla danışım','adamla danisim',
          'real adam','zəng edin','zeng edin',
          'call me','əlaqə','elaqe'
        )
      ),
      'Asia/Baku'
    );
  else
    update tenants
    set
      inbox_policy = coalesce(inbox_policy, '{}'::jsonb),
      timezone = coalesce(nullif(timezone, ''), 'Asia/Baku')
    where tenant_key = 'neox';
  end if;
exception when others then null;
end$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_tenants_updated_at') then
    execute '
      create trigger trg_tenants_updated_at
      before update on tenants
      for each row execute function set_updated_at();
    ';
  end if;
exception when others then null;
end$$;

-- ============================================================
-- content_items
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
        status like 'draft.%'
        OR status like 'asset.%'
        OR status like 'assets.%'
        OR status like 'render.%'
        OR status like 'publish.%'
        OR status in ('publishing','published')
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

create index if not exists idx_content_proposal_updated on content_items(proposal_id, updated_at desc);
create index if not exists idx_content_status_updated on content_items(status, updated_at desc);
create index if not exists idx_content_tenant_status on content_items(tenant_key, status, created_at desc);
create index if not exists idx_content_schedule on content_items(status, schedule_at);

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
-- inbox_threads
-- ============================================================
create table if not exists inbox_threads (
  id uuid primary key default gen_random_uuid(),

  tenant_key text not null default 'neox',
  channel text not null default 'instagram',
  external_thread_id text,
  external_user_id text,
  external_username text,
  customer_name text not null default '',

  status text not null default 'open',
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,

  unread_count int not null default 0,
  assigned_to text,
  labels jsonb not null default '[]'::jsonb,
  meta jsonb not null default '{}'::jsonb,

  handoff_active boolean not null default false,
  handoff_reason text,
  handoff_priority text not null default 'normal',
  handoff_at timestamptz,
  handoff_by text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table inbox_threads add column if not exists id uuid;
alter table inbox_threads add column if not exists tenant_key text;
alter table inbox_threads add column if not exists channel text;
alter table inbox_threads add column if not exists external_thread_id text;
alter table inbox_threads add column if not exists external_user_id text;
alter table inbox_threads add column if not exists external_username text;
alter table inbox_threads add column if not exists customer_name text;
alter table inbox_threads add column if not exists status text;
alter table inbox_threads add column if not exists last_message_at timestamptz;
alter table inbox_threads add column if not exists last_inbound_at timestamptz;
alter table inbox_threads add column if not exists last_outbound_at timestamptz;
alter table inbox_threads add column if not exists unread_count int;
alter table inbox_threads add column if not exists assigned_to text;
alter table inbox_threads add column if not exists labels jsonb default '[]'::jsonb;
alter table inbox_threads add column if not exists meta jsonb default '{}'::jsonb;
alter table inbox_threads add column if not exists handoff_active boolean default false;
alter table inbox_threads add column if not exists handoff_reason text;
alter table inbox_threads add column if not exists handoff_priority text default 'normal';
alter table inbox_threads add column if not exists handoff_at timestamptz;
alter table inbox_threads add column if not exists handoff_by text;
alter table inbox_threads add column if not exists created_at timestamptz default now();
alter table inbox_threads add column if not exists updated_at timestamptz default now();

do $$
begin
  begin
    alter table inbox_threads alter column id set default gen_random_uuid();
  exception when others then null;
  end;
  begin
    alter table inbox_threads alter column tenant_key set default 'neox';
  exception when others then null;
  end;
  begin
    alter table inbox_threads alter column channel set default 'instagram';
  exception when others then null;
  end;
  begin
    alter table inbox_threads alter column customer_name set default '';
  exception when others then null;
  end;
  begin
    alter table inbox_threads alter column status set default 'open';
  exception when others then null;
  end;
  begin
    alter table inbox_threads alter column unread_count set default 0;
  exception when others then null;
  end;
  begin
    alter table inbox_threads alter column labels set default '[]'::jsonb;
  exception when others then null;
  end;
  begin
    alter table inbox_threads alter column meta set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table inbox_threads alter column handoff_active set default false;
  exception when others then null;
  end;
  begin
    alter table inbox_threads alter column handoff_priority set default 'normal';
  exception when others then null;
  end;
  begin
    alter table inbox_threads alter column updated_at set default now();
  exception when others then null;
  end;
end$$;

do $$
begin
  begin
    execute 'alter table inbox_threads drop constraint if exists inbox_threads_status_check';
  exception when others then null;
  end;

  begin
    alter table inbox_threads
      add constraint inbox_threads_status_check
      check (status in ('open','pending','resolved','closed','spam'));
  exception when others then null;
  end;

  begin
    execute 'alter table inbox_threads drop constraint if exists inbox_threads_channel_check';
  exception when others then null;
  end;

  begin
    alter table inbox_threads
      add constraint inbox_threads_channel_check
      check (channel in ('instagram','facebook','whatsapp','web','email','other'));
  exception when others then null;
  end;

  begin
    execute 'alter table inbox_threads drop constraint if exists inbox_threads_handoff_priority_check';
  exception when others then null;
  end;

  begin
    alter table inbox_threads
      add constraint inbox_threads_handoff_priority_check
      check (handoff_priority in ('low','normal','high','urgent'));
  exception when others then null;
  end;
end$$;

drop index if exists uq_inbox_threads_external;

create unique index if not exists uq_inbox_threads_tenant_channel_external
  on inbox_threads(tenant_key, channel, external_thread_id)
  where external_thread_id is not null;

create index if not exists idx_inbox_threads_tenant_status_updated
  on inbox_threads(tenant_key, status, updated_at desc);

create index if not exists idx_inbox_threads_last_message
  on inbox_threads(last_message_at desc);

create index if not exists idx_inbox_threads_unread
  on inbox_threads(unread_count desc, updated_at desc);

create index if not exists idx_inbox_threads_handoff_active
  on inbox_threads(tenant_key, handoff_active, updated_at desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_inbox_threads_updated_at') then
    execute '
      create trigger trg_inbox_threads_updated_at
      before update on inbox_threads
      for each row execute function set_updated_at();
    ';
  end if;
exception when others then null;
end$$;

-- ============================================================
-- inbox_messages
-- ============================================================
create table if not exists inbox_messages (
  id uuid primary key default gen_random_uuid(),

  thread_id uuid not null,
  tenant_key text not null default 'neox',
  direction text not null default 'inbound',
  sender_type text not null default 'customer',

  external_message_id text,
  message_type text not null default 'text',
  text text not null default '',

  attachments jsonb not null default '[]'::jsonb,
  meta jsonb not null default '{}'::jsonb,

  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table inbox_messages add column if not exists id uuid;
alter table inbox_messages add column if not exists thread_id uuid;
alter table inbox_messages add column if not exists tenant_key text;
alter table inbox_messages add column if not exists direction text;
alter table inbox_messages add column if not exists sender_type text;
alter table inbox_messages add column if not exists external_message_id text;
alter table inbox_messages add column if not exists message_type text;
alter table inbox_messages add column if not exists text text;
alter table inbox_messages add column if not exists attachments jsonb default '[]'::jsonb;
alter table inbox_messages add column if not exists meta jsonb default '{}'::jsonb;
alter table inbox_messages add column if not exists sent_at timestamptz default now();
alter table inbox_messages add column if not exists created_at timestamptz default now();

do $$
begin
  begin
    alter table inbox_messages alter column id set default gen_random_uuid();
  exception when others then null;
  end;
  begin
    alter table inbox_messages alter column tenant_key set default 'neox';
  exception when others then null;
  end;
  begin
    alter table inbox_messages alter column direction set default 'inbound';
  exception when others then null;
  end;
  begin
    alter table inbox_messages alter column sender_type set default 'customer';
  exception when others then null;
  end;
  begin
    alter table inbox_messages alter column message_type set default 'text';
  exception when others then null;
  end;
  begin
    alter table inbox_messages alter column text set default '';
  exception when others then null;
  end;
  begin
    alter table inbox_messages alter column attachments set default '[]'::jsonb;
  exception when others then null;
  end;
  begin
    alter table inbox_messages alter column meta set default '{}'::jsonb;
  exception when others then null;
  end;
end$$;

do $$
begin
  begin
    execute 'alter table inbox_messages drop constraint if exists inbox_messages_direction_check';
  exception when others then null;
  end;

  begin
    alter table inbox_messages
      add constraint inbox_messages_direction_check
      check (direction in ('inbound','outbound','internal'));
  exception when others then null;
  end;

  begin
    execute 'alter table inbox_messages drop constraint if exists inbox_messages_sender_type_check';
  exception when others then null;
  end;

  begin
    alter table inbox_messages
      add constraint inbox_messages_sender_type_check
      check (sender_type in ('customer','agent','system','ai'));
  exception when others then null;
  end;

  begin
    execute 'alter table inbox_messages drop constraint if exists inbox_messages_message_type_check';
  exception when others then null;
  end;

  begin
    alter table inbox_messages
      add constraint inbox_messages_message_type_check
      check (message_type in ('text','image','video','audio','file','event','other'));
  exception when others then null;
  end;
end$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inbox_messages_thread_id_fkey') then
    begin
      alter table inbox_messages
        add constraint inbox_messages_thread_id_fkey
        foreign key (thread_id) references inbox_threads(id) on delete cascade;
    exception when others then null;
    end;
  end if;
end$$;

create unique index if not exists uq_inbox_messages_thread_direction_external
  on inbox_messages(thread_id, direction, external_message_id)
  where external_message_id is not null;

create unique index if not exists uq_inbox_messages_external
  on inbox_messages(thread_id, external_message_id)
  where external_message_id is not null;

create index if not exists idx_inbox_messages_thread_sent
  on inbox_messages(thread_id, sent_at asc);

create index if not exists idx_inbox_messages_tenant_created
  on inbox_messages(tenant_key, created_at desc);

create index if not exists idx_inbox_messages_external_lookup
  on inbox_messages(tenant_key, external_message_id, created_at desc)
  where external_message_id is not null;

-- ============================================================
-- leads
-- ============================================================
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),

  tenant_key text not null default 'neox',
  source text not null default 'manual',
  source_ref text,

  inbox_thread_id uuid,
  proposal_id uuid,

  full_name text not null default '',
  username text,
  company text,
  phone text,
  email text,

  interest text,
  notes text not null default '',

  stage text not null default 'new',
  score int not null default 0,
  status text not null default 'open',

  extra jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table leads add column if not exists id uuid;
alter table leads add column if not exists tenant_key text;
alter table leads add column if not exists source text;
alter table leads add column if not exists source_ref text;
alter table leads add column if not exists inbox_thread_id uuid;
alter table leads add column if not exists proposal_id uuid;
alter table leads add column if not exists full_name text;
alter table leads add column if not exists username text;
alter table leads add column if not exists company text;
alter table leads add column if not exists phone text;
alter table leads add column if not exists email text;
alter table leads add column if not exists interest text;
alter table leads add column if not exists notes text;
alter table leads add column if not exists stage text;
alter table leads add column if not exists score int;
alter table leads add column if not exists status text;
alter table leads add column if not exists extra jsonb default '{}'::jsonb;
alter table leads add column if not exists created_at timestamptz default now();
alter table leads add column if not exists updated_at timestamptz default now();

do $$
begin
  begin
    alter table leads alter column id set default gen_random_uuid();
  exception when others then null;
  end;
  begin
    alter table leads alter column tenant_key set default 'neox';
  exception when others then null;
  end;
  begin
    alter table leads alter column source set default 'manual';
  exception when others then null;
  end;
  begin
    alter table leads alter column full_name set default '';
  exception when others then null;
  end;
  begin
    alter table leads alter column notes set default '';
  exception when others then null;
  end;
  begin
    alter table leads alter column stage set default 'new';
  exception when others then null;
  end;
  begin
    alter table leads alter column score set default 0;
  exception when others then null;
  end;
  begin
    alter table leads alter column status set default 'open';
  exception when others then null;
  end;
  begin
    alter table leads alter column extra set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table leads alter column updated_at set default now();
  exception when others then null;
  end;
end$$;

do $$
begin
  begin
    execute 'alter table leads drop constraint if exists leads_stage_check';
  exception when others then null;
  end;

  begin
    alter table leads
      add constraint leads_stage_check
      check (stage in ('new','contacted','qualified','proposal','won','lost'));
  exception when others then null;
  end;

  begin
    execute 'alter table leads drop constraint if exists leads_status_check';
  exception when others then null;
  end;

  begin
    alter table leads
      add constraint leads_status_check
      check (status in ('open','archived','spam','closed'));
  exception when others then null;
  end;
end$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_inbox_thread_id_fkey') then
    begin
      alter table leads
        add constraint leads_inbox_thread_id_fkey
        foreign key (inbox_thread_id) references inbox_threads(id) on delete set null;
    exception when others then null;
    end;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leads_proposal_id_fkey') then
    begin
      alter table leads
        add constraint leads_proposal_id_fkey
        foreign key (proposal_id) references proposals(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;

create index if not exists idx_leads_tenant_created
  on leads(tenant_key, created_at desc);

create index if not exists idx_leads_stage_created
  on leads(stage, created_at desc);

create index if not exists idx_leads_status_created
  on leads(status, created_at desc);

create index if not exists idx_leads_inbox_thread
  on leads(inbox_thread_id);

create index if not exists idx_leads_email
  on leads(email);

create index if not exists idx_leads_phone
  on leads(phone);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_leads_updated_at') then
    execute '
      create trigger trg_leads_updated_at
      before update on leads
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

  begin
    update inbox_messages
      set text = convert_from(convert_to(text, 'LATIN1'), 'UTF8')
    where text is not null and text ~ 'Ã.|Â.|â€|â€™|â€œ|â€�|â€“|â€”|â€¦';
  exception when others then null;
  end;

  begin
    update leads
      set full_name = convert_from(convert_to(full_name, 'LATIN1'), 'UTF8')
    where full_name is not null and full_name ~ 'Ã.|Â.|â€|â€™|â€œ|â€�|â€“|â€”|â€¦';
  exception when others then null;
  end;
exception when others then null;
end$$;

-- ============================================================
-- leads CRM workflow extensions
-- ============================================================

alter table leads add column if not exists owner text;
alter table leads add column if not exists priority text default 'normal';
alter table leads add column if not exists value_azn numeric(12,2) default 0;
alter table leads add column if not exists follow_up_at timestamptz;
alter table leads add column if not exists next_action text;
alter table leads add column if not exists won_reason text;
alter table leads add column if not exists lost_reason text;

do $$
begin
  begin
    alter table leads alter column priority set default 'normal';
  exception when others then null;
  end;

  begin
    alter table leads alter column value_azn set default 0;
  exception when others then null;
  end;

  begin
    execute 'update leads set priority = ''normal'' where priority is null or priority = ''''';
  exception when others then null;
  end;

  begin
    execute 'update leads set value_azn = 0 where value_azn is null';
  exception when others then null;
  end;
end$$;

do $$
begin
  begin
    execute 'alter table leads drop constraint if exists leads_priority_check';
  exception when others then null;
  end;

  begin
    alter table leads
      add constraint leads_priority_check
      check (priority in ('low','normal','high','urgent'));
  exception when others then null;
  end;
end$$;

create index if not exists idx_leads_owner_updated
  on leads(owner, updated_at desc);

create index if not exists idx_leads_priority_updated
  on leads(priority, updated_at desc);

create index if not exists idx_leads_follow_up
  on leads(follow_up_at);

create index if not exists idx_leads_value
  on leads(value_azn desc);

-- ============================================================
-- lead_events
-- ============================================================

create table if not exists lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null,
  tenant_key text not null default 'neox',
  type text not null,
  actor text not null default 'ai_hq',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table lead_events add column if not exists id uuid;
alter table lead_events add column if not exists lead_id uuid;
alter table lead_events add column if not exists tenant_key text default 'neox';
alter table lead_events add column if not exists type text;
alter table lead_events add column if not exists actor text default 'ai_hq';
alter table lead_events add column if not exists payload jsonb default '{}'::jsonb;
alter table lead_events add column if not exists created_at timestamptz default now();

do $$
begin
  begin
    alter table lead_events alter column id set default gen_random_uuid();
  exception when others then null;
  end;

  begin
    alter table lead_events alter column tenant_key set default 'neox';
  exception when others then null;
  end;

  begin
    alter table lead_events alter column actor set default 'ai_hq';
  exception when others then null;
  end;

  begin
    alter table lead_events alter column payload set default '{}'::jsonb;
  exception when others then null;
  end;
end$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lead_events_lead_id_fkey') then
    begin
      alter table lead_events
        add constraint lead_events_lead_id_fkey
        foreign key (lead_id) references leads(id) on delete cascade;
    exception when others then null;
    end;
  end if;
end$$;

create index if not exists idx_lead_events_lead_created
  on lead_events(lead_id, created_at desc);

create index if not exists idx_lead_events_tenant_created
  on lead_events(tenant_key, created_at desc);

create index if not exists idx_lead_events_type_created
  on lead_events(type, created_at desc);

-- ============================================================
-- comments
-- ============================================================
create table if not exists comments (
  id uuid primary key default gen_random_uuid(),

  tenant_key text not null default 'neox',
  channel text not null default 'instagram',
  source text not null default 'meta',

  external_comment_id text not null,
  external_parent_comment_id text,
  external_post_id text,

  external_user_id text,
  external_username text,
  customer_name text,

  text text not null default '',
  classification jsonb not null default '{}'::jsonb,
  raw jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table comments add column if not exists id uuid;
alter table comments add column if not exists tenant_key text;
alter table comments add column if not exists channel text;
alter table comments add column if not exists source text;
alter table comments add column if not exists external_comment_id text;
alter table comments add column if not exists external_parent_comment_id text;
alter table comments add column if not exists external_post_id text;
alter table comments add column if not exists external_user_id text;
alter table comments add column if not exists external_username text;
alter table comments add column if not exists customer_name text;
alter table comments add column if not exists text text;
alter table comments add column if not exists classification jsonb default '{}'::jsonb;
alter table comments add column if not exists raw jsonb default '{}'::jsonb;
alter table comments add column if not exists created_at timestamptz default now();
alter table comments add column if not exists updated_at timestamptz default now();

do $$
begin
  begin
    alter table comments alter column id set default gen_random_uuid();
  exception when others then null;
  end;
  begin
    alter table comments alter column tenant_key set default 'neox';
  exception when others then null;
  end;
  begin
    alter table comments alter column channel set default 'instagram';
  exception when others then null;
  end;
  begin
    alter table comments alter column source set default 'meta';
  exception when others then null;
  end;
  begin
    alter table comments alter column text set default '';
  exception when others then null;
  end;
  begin
    alter table comments alter column classification set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table comments alter column raw set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table comments alter column updated_at set default now();
  exception when others then null;
  end;
end$$;

create unique index if not exists uq_comments_tenant_channel_external_comment
  on comments(tenant_key, channel, external_comment_id);

create index if not exists idx_comments_tenant_created
  on comments(tenant_key, created_at desc);

create index if not exists idx_comments_channel_created
  on comments(channel, created_at desc);

create index if not exists idx_comments_post
  on comments(external_post_id);

create index if not exists idx_comments_category
  on comments((classification->>'category'), created_at desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_comments_updated_at') then
    execute '
      create trigger trg_comments_updated_at
      before update on comments
      for each row execute function set_updated_at();
    ';
  end if;
exception when others then null;
end$$;

-- ============================================================
-- inbox_outbound_attempts
-- retry / resend queue for outbound provider delivery
-- ============================================================

create table if not exists inbox_outbound_attempts (
  id uuid primary key default gen_random_uuid(),

  message_id uuid not null,
  thread_id uuid not null,
  tenant_key text not null default 'neox',
  channel text not null default 'instagram',

  provider text not null default 'meta',
  recipient_id text,
  provider_message_id text,

  payload jsonb not null default '{}'::jsonb,
  provider_response jsonb not null default '{}'::jsonb,

  status text not null default 'queued',
  attempt_count int not null default 0,
  max_attempts int not null default 5,

  queued_at timestamptz not null default now(),
  first_attempt_at timestamptz,
  last_attempt_at timestamptz,
  next_retry_at timestamptz,

  sent_at timestamptz,
  last_error text,
  last_error_code text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table inbox_outbound_attempts add column if not exists id uuid;
alter table inbox_outbound_attempts add column if not exists message_id uuid;
alter table inbox_outbound_attempts add column if not exists thread_id uuid;
alter table inbox_outbound_attempts add column if not exists tenant_key text default 'neox';
alter table inbox_outbound_attempts add column if not exists channel text default 'instagram';
alter table inbox_outbound_attempts add column if not exists provider text default 'meta';
alter table inbox_outbound_attempts add column if not exists recipient_id text;
alter table inbox_outbound_attempts add column if not exists provider_message_id text;
alter table inbox_outbound_attempts add column if not exists payload jsonb default '{}'::jsonb;
alter table inbox_outbound_attempts add column if not exists provider_response jsonb default '{}'::jsonb;
alter table inbox_outbound_attempts add column if not exists status text default 'queued';
alter table inbox_outbound_attempts add column if not exists attempt_count int default 0;
alter table inbox_outbound_attempts add column if not exists max_attempts int default 5;
alter table inbox_outbound_attempts add column if not exists queued_at timestamptz default now();
alter table inbox_outbound_attempts add column if not exists first_attempt_at timestamptz;
alter table inbox_outbound_attempts add column if not exists last_attempt_at timestamptz;
alter table inbox_outbound_attempts add column if not exists next_retry_at timestamptz;
alter table inbox_outbound_attempts add column if not exists sent_at timestamptz;
alter table inbox_outbound_attempts add column if not exists last_error text;
alter table inbox_outbound_attempts add column if not exists last_error_code text;
alter table inbox_outbound_attempts add column if not exists created_at timestamptz default now();
alter table inbox_outbound_attempts add column if not exists updated_at timestamptz default now();

do $$
begin
  begin
    alter table inbox_outbound_attempts alter column id set default gen_random_uuid();
  exception when others then null;
  end;
  begin
    alter table inbox_outbound_attempts alter column tenant_key set default 'neox';
  exception when others then null;
  end;
  begin
    alter table inbox_outbound_attempts alter column channel set default 'instagram';
  exception when others then null;
  end;
  begin
    alter table inbox_outbound_attempts alter column provider set default 'meta';
  exception when others then null;
  end;
  begin
    alter table inbox_outbound_attempts alter column payload set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table inbox_outbound_attempts alter column provider_response set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table inbox_outbound_attempts alter column status set default 'queued';
  exception when others then null;
  end;
  begin
    alter table inbox_outbound_attempts alter column attempt_count set default 0;
  exception when others then null;
  end;
  begin
    alter table inbox_outbound_attempts alter column max_attempts set default 5;
  exception when others then null;
  end;
  begin
    alter table inbox_outbound_attempts alter column queued_at set default now();
  exception when others then null;
  end;
  begin
    alter table inbox_outbound_attempts alter column updated_at set default now();
  exception when others then null;
  end;
end$$;

do $$
begin
  begin
    execute 'alter table inbox_outbound_attempts drop constraint if exists inbox_outbound_attempts_status_check';
  exception when others then null;
  end;

  begin
    alter table inbox_outbound_attempts
      add constraint inbox_outbound_attempts_status_check
      check (status in ('queued','sending','sent','failed','retrying','dead'));
  exception when others then null;
  end;
end$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inbox_outbound_attempts_message_id_fkey') then
    begin
      alter table inbox_outbound_attempts
        add constraint inbox_outbound_attempts_message_id_fkey
        foreign key (message_id) references inbox_messages(id) on delete cascade;
    exception when others then null;
    end;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'inbox_outbound_attempts_thread_id_fkey') then
    begin
      alter table inbox_outbound_attempts
        add constraint inbox_outbound_attempts_thread_id_fkey
        foreign key (thread_id) references inbox_threads(id) on delete cascade;
    exception when others then null;
    end;
  end if;
end$$;

create unique index if not exists uq_inbox_outbound_attempts_provider_message_id
  on inbox_outbound_attempts(provider, provider_message_id)
  where provider_message_id is not null;

create index if not exists idx_inbox_outbound_attempts_message
  on inbox_outbound_attempts(message_id, created_at desc);

create index if not exists idx_inbox_outbound_attempts_thread
  on inbox_outbound_attempts(thread_id, created_at desc);

create index if not exists idx_inbox_outbound_attempts_retry_queue
  on inbox_outbound_attempts(status, next_retry_at asc, created_at asc);

create index if not exists idx_inbox_outbound_attempts_tenant_status
  on inbox_outbound_attempts(tenant_key, status, created_at desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_inbox_outbound_attempts_updated_at') then
    execute '
      create trigger trg_inbox_outbound_attempts_updated_at
      before update on inbox_outbound_attempts
      for each row execute function set_updated_at();
    ';
  end if;
exception when others then null;
end$$;