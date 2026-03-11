-- src/db/schema.sql
-- FINAL v10.1 — AI HQ schema (professional SaaS / tenant-first / provider-ready)
-- ============================================================
-- Goals:
-- ✅ true multi-tenant structure
-- ✅ modular tenant config tables
-- ✅ keep runtime compatibility with tenant_key
-- ✅ add tenant_id for long-term correctness
-- ✅ provider / channel / agent / policy separation
-- ✅ safe upgrade blocks preserved
-- ✅ no plain secrets in public config tables
-- ✅ settings/auth role plan aligned
-- ============================================================

create extension if not exists pgcrypto;

-- ============================================================
-- shared helper: updated_at trigger fn
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_proc where proname = 'set_updated_at'
  ) then
    execute $fn$
      create or replace function set_updated_at()
      returns trigger
      as $f$
      begin
        new.updated_at = now();
        return new;
      end;
      $f$ language plpgsql;
    $fn$;
  end if;
exception when others then null;
end$$;

-- ============================================================
-- TENANTS / SaaS foundation
-- ============================================================

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  tenant_key text not null unique,
  company_name text not null default '',
  legal_name text,
  industry_key text not null default 'generic_business',
  country_code text,
  timezone text not null default 'Asia/Baku',
  default_language text not null default 'az',
  enabled_languages jsonb not null default '["az"]'::jsonb,
  market_region text,
  plan_key text not null default 'starter',
  status text not null default 'active',
  active boolean not null default true,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenants add column if not exists company_name text default '';
alter table tenants add column if not exists legal_name text;
alter table tenants add column if not exists industry_key text default 'generic_business';
alter table tenants add column if not exists country_code text;
alter table tenants add column if not exists default_language text default 'az';
alter table tenants add column if not exists enabled_languages jsonb default '["az"]'::jsonb;
alter table tenants add column if not exists market_region text;
alter table tenants add column if not exists plan_key text default 'starter';
alter table tenants add column if not exists status text default 'active';
alter table tenants add column if not exists active boolean default true;
alter table tenants add column if not exists onboarding_completed_at timestamptz;
alter table tenants add column if not exists updated_at timestamptz default now();

do $$
begin
  begin
    alter table tenants alter column id set default gen_random_uuid();
  exception when others then null;
  end;
  begin
    alter table tenants alter column company_name set default '';
  exception when others then null;
  end;
  begin
    alter table tenants alter column industry_key set default 'generic_business';
  exception when others then null;
  end;
  begin
    alter table tenants alter column timezone set default 'Asia/Baku';
  exception when others then null;
  end;
  begin
    alter table tenants alter column default_language set default 'az';
  exception when others then null;
  end;
  begin
    alter table tenants alter column enabled_languages set default '["az"]'::jsonb;
  exception when others then null;
  end;
  begin
    alter table tenants alter column plan_key set default 'starter';
  exception when others then null;
  end;
  begin
    alter table tenants alter column status set default 'active';
  exception when others then null;
  end;
  begin
    alter table tenants alter column active set default true;
  exception when others then null;
  end;
  begin
    alter table tenants alter column updated_at set default now();
  exception when others then null;
  end;
end$$;

do $$
begin
  begin
    execute 'alter table tenants drop constraint if exists tenants_status_check';
  exception when others then null;
  end;

  begin
    alter table tenants
      add constraint tenants_status_check
      check (status in ('active','paused','trial','suspended','archived'));
  exception when others then null;
  end;
end$$;

create index if not exists idx_tenants_key on tenants(tenant_key);
create index if not exists idx_tenants_active on tenants(active);
create index if not exists idx_tenants_status on tenants(status);
create index if not exists idx_tenants_industry on tenants(industry_key);

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

-- ------------------------------------------------------------
-- tenant_profiles (brand / business identity)
-- ------------------------------------------------------------
create table if not exists tenant_profiles (
  tenant_id uuid primary key,
  brand_name text not null default '',
  website_url text,
  public_email text,
  public_phone text,
  audience_summary text not null default '',
  services_summary text not null default '',
  value_proposition text not null default '',
  brand_summary text not null default '',
  tone_of_voice text not null default 'professional',
  preferred_cta text not null default '',
  banned_phrases jsonb not null default '[]'::jsonb,
  communication_rules jsonb not null default '{}'::jsonb,
  visual_style jsonb not null default '{}'::jsonb,
  extra_context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenant_profiles add column if not exists brand_name text default '';
alter table tenant_profiles add column if not exists website_url text;
alter table tenant_profiles add column if not exists public_email text;
alter table tenant_profiles add column if not exists public_phone text;
alter table tenant_profiles add column if not exists audience_summary text default '';
alter table tenant_profiles add column if not exists services_summary text default '';
alter table tenant_profiles add column if not exists value_proposition text default '';
alter table tenant_profiles add column if not exists brand_summary text default '';
alter table tenant_profiles add column if not exists tone_of_voice text default 'professional';
alter table tenant_profiles add column if not exists preferred_cta text default '';
alter table tenant_profiles add column if not exists banned_phrases jsonb default '[]'::jsonb;
alter table tenant_profiles add column if not exists communication_rules jsonb default '{}'::jsonb;
alter table tenant_profiles add column if not exists visual_style jsonb default '{}'::jsonb;
alter table tenant_profiles add column if not exists extra_context jsonb default '{}'::jsonb;
alter table tenant_profiles add column if not exists created_at timestamptz default now();
alter table tenant_profiles add column if not exists updated_at timestamptz default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenant_profiles_tenant_id_fkey') then
    begin
      alter table tenant_profiles
        add constraint tenant_profiles_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete cascade;
    exception when others then null;
    end;
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_tenant_profiles_updated_at') then
    execute '
      create trigger trg_tenant_profiles_updated_at
      before update on tenant_profiles
      for each row execute function set_updated_at();
    ';
  end if;
exception when others then null;
end$$;

-- ------------------------------------------------------------
-- tenant_ai_policies (automation / approvals / risk rules)
-- ------------------------------------------------------------
create table if not exists tenant_ai_policies (
  tenant_id uuid primary key,
  auto_reply_enabled boolean not null default true,
  suppress_ai_during_handoff boolean not null default true,
  mark_seen_enabled boolean not null default true,
  typing_indicator_enabled boolean not null default true,
  create_lead_enabled boolean not null default true,

  approval_required_content boolean not null default true,
  approval_required_publish boolean not null default true,

  quiet_hours_enabled boolean not null default false,
  quiet_hours jsonb not null default '{}'::jsonb,

  inbox_policy jsonb not null default '{}'::jsonb,
  comment_policy jsonb not null default '{}'::jsonb,
  content_policy jsonb not null default '{}'::jsonb,
  escalation_rules jsonb not null default '{}'::jsonb,
  risk_rules jsonb not null default '{}'::jsonb,
  lead_scoring_rules jsonb not null default '{}'::jsonb,
  publish_policy jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenant_ai_policies add column if not exists auto_reply_enabled boolean default true;
alter table tenant_ai_policies add column if not exists suppress_ai_during_handoff boolean default true;
alter table tenant_ai_policies add column if not exists mark_seen_enabled boolean default true;
alter table tenant_ai_policies add column if not exists typing_indicator_enabled boolean default true;
alter table tenant_ai_policies add column if not exists create_lead_enabled boolean default true;
alter table tenant_ai_policies add column if not exists approval_required_content boolean default true;
alter table tenant_ai_policies add column if not exists approval_required_publish boolean default true;
alter table tenant_ai_policies add column if not exists quiet_hours_enabled boolean default false;
alter table tenant_ai_policies add column if not exists quiet_hours jsonb default '{}'::jsonb;
alter table tenant_ai_policies add column if not exists inbox_policy jsonb default '{}'::jsonb;
alter table tenant_ai_policies add column if not exists comment_policy jsonb default '{}'::jsonb;
alter table tenant_ai_policies add column if not exists content_policy jsonb default '{}'::jsonb;
alter table tenant_ai_policies add column if not exists escalation_rules jsonb default '{}'::jsonb;
alter table tenant_ai_policies add column if not exists risk_rules jsonb default '{}'::jsonb;
alter table tenant_ai_policies add column if not exists lead_scoring_rules jsonb default '{}'::jsonb;
alter table tenant_ai_policies add column if not exists publish_policy jsonb default '{}'::jsonb;
alter table tenant_ai_policies add column if not exists created_at timestamptz default now();
alter table tenant_ai_policies add column if not exists updated_at timestamptz default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenant_ai_policies_tenant_id_fkey') then
    begin
      alter table tenant_ai_policies
        add constraint tenant_ai_policies_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete cascade;
    exception when others then null;
    end;
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_tenant_ai_policies_updated_at') then
    execute '
      create trigger trg_tenant_ai_policies_updated_at
      before update on tenant_ai_policies
      for each row execute function set_updated_at();
    ';
  end if;
exception when others then null;
end$$;

-- ------------------------------------------------------------
-- tenant_channels (Instagram / WhatsApp / Messenger / etc.)
-- ------------------------------------------------------------
create table if not exists tenant_channels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  channel_type text not null,
  provider text not null,
  display_name text not null default '',
  external_account_id text,
  external_page_id text,
  external_user_id text,
  external_username text,
  status text not null default 'disconnected',
  is_primary boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  secrets_ref text,
  health jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenant_channels add column if not exists display_name text default '';
alter table tenant_channels add column if not exists external_account_id text;
alter table tenant_channels add column if not exists external_page_id text;
alter table tenant_channels add column if not exists external_user_id text;
alter table tenant_channels add column if not exists external_username text;
alter table tenant_channels add column if not exists status text default 'disconnected';
alter table tenant_channels add column if not exists is_primary boolean default false;
alter table tenant_channels add column if not exists config jsonb default '{}'::jsonb;
alter table tenant_channels add column if not exists secrets_ref text;
alter table tenant_channels add column if not exists health jsonb default '{}'::jsonb;
alter table tenant_channels add column if not exists last_sync_at timestamptz;
alter table tenant_channels add column if not exists created_at timestamptz default now();
alter table tenant_channels add column if not exists updated_at timestamptz default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenant_channels_tenant_id_fkey') then
    begin
      alter table tenant_channels
        add constraint tenant_channels_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete cascade;
    exception when others then null;
    end;
  end if;

  begin
    execute 'alter table tenant_channels drop constraint if exists tenant_channels_status_check';
  exception when others then null;
  end;

  begin
    alter table tenant_channels
      add constraint tenant_channels_status_check
      check (status in ('disconnected','connecting','connected','error','disabled'));
  exception when others then null;
  end;

  begin
    execute 'alter table tenant_channels drop constraint if exists tenant_channels_channel_type_check';
  exception when others then null;
  end;

  begin
    alter table tenant_channels
      add constraint tenant_channels_channel_type_check
      check (channel_type in ('instagram','facebook','whatsapp','telegram','webchat','email','other'));
  exception when others then null;
  end;
end$$;

create unique index if not exists uq_tenant_channels_unique_account
  on tenant_channels(tenant_id, channel_type, provider, coalesce(external_account_id, ''), coalesce(external_page_id, ''), coalesce(external_user_id, ''));

create index if not exists idx_tenant_channels_tenant_status
  on tenant_channels(tenant_id, status, updated_at desc);

create index if not exists idx_tenant_channels_type
  on tenant_channels(tenant_id, channel_type, updated_at desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_tenant_channels_updated_at') then
    execute '
      create trigger trg_tenant_channels_updated_at
      before update on tenant_channels
      for each row execute function set_updated_at();
    ';
  end if;
exception when others then null;
end$$;

-- ------------------------------------------------------------
-- tenant_integrations (OpenAI / n8n / Twilio / Cloudinary / etc.)
-- ------------------------------------------------------------
create table if not exists tenant_integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  integration_type text not null,
  provider text not null,
  display_name text not null default '',
  status text not null default 'disabled',
  config jsonb not null default '{}'::jsonb,
  secrets_ref text,
  health jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenant_integrations add column if not exists display_name text default '';
alter table tenant_integrations add column if not exists status text default 'disabled';
alter table tenant_integrations add column if not exists config jsonb default '{}'::jsonb;
alter table tenant_integrations add column if not exists secrets_ref text;
alter table tenant_integrations add column if not exists health jsonb default '{}'::jsonb;
alter table tenant_integrations add column if not exists last_sync_at timestamptz;
alter table tenant_integrations add column if not exists created_at timestamptz default now();
alter table tenant_integrations add column if not exists updated_at timestamptz default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenant_integrations_tenant_id_fkey') then
    begin
      alter table tenant_integrations
        add constraint tenant_integrations_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete cascade;
    exception when others then null;
    end;
  end if;

  begin
    execute 'alter table tenant_integrations drop constraint if exists tenant_integrations_status_check';
  exception when others then null;
  end;

  begin
    alter table tenant_integrations
      add constraint tenant_integrations_status_check
      check (status in ('disabled','enabled','error','pending'));
  exception when others then null;
  end;
end$$;

create unique index if not exists uq_tenant_integrations_type_provider
  on tenant_integrations(tenant_id, integration_type, provider);

create index if not exists idx_tenant_integrations_tenant_status
  on tenant_integrations(tenant_id, status, updated_at desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_tenant_integrations_updated_at') then
    execute '
      create trigger trg_tenant_integrations_updated_at
      before update on tenant_integrations
      for each row execute function set_updated_at();
    ';
  end if;
exception when others then null;
end$$;

-- ============================================================
-- tenant_secrets
-- encrypted per-tenant provider secrets
-- ============================================================
create table if not exists tenant_secrets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  provider text not null,
  secret_key text not null,
  secret_value_enc text not null,
  secret_value_iv text not null,
  secret_value_tag text not null,
  version int not null default 1,
  is_active boolean not null default true,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenant_secrets add column if not exists tenant_id uuid;
alter table tenant_secrets add column if not exists provider text;
alter table tenant_secrets add column if not exists secret_key text;
alter table tenant_secrets add column if not exists secret_value_enc text;
alter table tenant_secrets add column if not exists secret_value_iv text;
alter table tenant_secrets add column if not exists secret_value_tag text;
alter table tenant_secrets add column if not exists version int default 1;
alter table tenant_secrets add column if not exists is_active boolean default true;
alter table tenant_secrets add column if not exists created_by text;
alter table tenant_secrets add column if not exists updated_by text;
alter table tenant_secrets add column if not exists created_at timestamptz default now();
alter table tenant_secrets add column if not exists updated_at timestamptz default now();

do $$
begin
  begin
    alter table tenant_secrets alter column id set default gen_random_uuid();
  exception when others then null;
  end;

  begin
    alter table tenant_secrets alter column version set default 1;
  exception when others then null;
  end;

  begin
    alter table tenant_secrets alter column is_active set default true;
  exception when others then null;
  end;

  begin
    alter table tenant_secrets alter column created_at set default now();
  exception when others then null;
  end;

  begin
    alter table tenant_secrets alter column updated_at set default now();
  exception when others then null;
  end;

  if not exists (select 1 from pg_constraint where conname = 'tenant_secrets_tenant_id_fkey') then
    begin
      alter table tenant_secrets
        add constraint tenant_secrets_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete cascade;
    exception when others then null;
    end;
  end if;
end$$;

create unique index if not exists uq_tenant_secrets_provider_key
  on tenant_secrets(tenant_id, provider, secret_key);

create index if not exists idx_tenant_secrets_tenant_provider
  on tenant_secrets(tenant_id, provider, updated_at desc);

create index if not exists idx_tenant_secrets_active
  on tenant_secrets(tenant_id, is_active, updated_at desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_tenant_secrets_updated_at') then
    execute '
      create trigger trg_tenant_secrets_updated_at
      before update on tenant_secrets
      for each row execute function set_updated_at();
    ';
  end if;
exception when others then null;
end$$;

-- ------------------------------------------------------------
-- tenant_users (workspace users / roles / auth-ready)
-- ------------------------------------------------------------
create table if not exists tenant_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,

  user_email text not null,
  full_name text not null default '',

  role text not null default 'operator',
  status text not null default 'invited',

  password_hash text,
  auth_provider text not null default 'local',
  email_verified boolean not null default false,

  session_version int not null default 1,

  permissions jsonb not null default '{}'::jsonb,
  meta jsonb not null default '{}'::jsonb,

  last_seen_at timestamptz,
  last_login_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenant_users add column if not exists tenant_id uuid;
alter table tenant_users add column if not exists user_email text;
alter table tenant_users add column if not exists full_name text default '';
alter table tenant_users add column if not exists role text default 'operator';
alter table tenant_users add column if not exists status text default 'invited';

alter table tenant_users add column if not exists password_hash text;
alter table tenant_users add column if not exists auth_provider text default 'local';
alter table tenant_users add column if not exists email_verified boolean default false;
alter table tenant_users add column if not exists session_version int default 1;

alter table tenant_users add column if not exists permissions jsonb default '{}'::jsonb;
alter table tenant_users add column if not exists meta jsonb default '{}'::jsonb;

alter table tenant_users add column if not exists last_seen_at timestamptz;
alter table tenant_users add column if not exists last_login_at timestamptz;

alter table tenant_users add column if not exists created_at timestamptz default now();
alter table tenant_users add column if not exists updated_at timestamptz default now();

do $$
begin
  begin
    alter table tenant_users alter column id set default gen_random_uuid();
  exception when others then null;
  end;

  begin
    alter table tenant_users alter column full_name set default '';
  exception when others then null;
  end;

  begin
    alter table tenant_users alter column role set default 'operator';
  exception when others then null;
  end;

  begin
    alter table tenant_users alter column status set default 'invited';
  exception when others then null;
  end;

  begin
    alter table tenant_users alter column auth_provider set default 'local';
  exception when others then null;
  end;

  begin
    alter table tenant_users alter column email_verified set default false;
  exception when others then null;
  end;

  begin
    alter table tenant_users alter column session_version set default 1;
  exception when others then null;
  end;

  begin
    alter table tenant_users alter column permissions set default '{}'::jsonb;
  exception when others then null;
  end;

  begin
    alter table tenant_users alter column meta set default '{}'::jsonb;
  exception when others then null;
  end;

  begin
    alter table tenant_users alter column created_at set default now();
  exception when others then null;
  end;

  begin
    alter table tenant_users alter column updated_at set default now();
  exception when others then null;
  end;

  if not exists (select 1 from pg_constraint where conname = 'tenant_users_tenant_id_fkey') then
    begin
      alter table tenant_users
        add constraint tenant_users_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete cascade;
    exception when others then null;
    end;
  end if;

  begin
    execute 'alter table tenant_users drop constraint if exists tenant_users_role_check';
  exception when others then null;
  end;

  begin
    alter table tenant_users
      add constraint tenant_users_role_check
      check (role in ('owner','admin','operator','member','marketer','analyst'));
  exception when others then null;
  end;

  begin
    execute 'alter table tenant_users drop constraint if exists tenant_users_status_check';
  exception when others then null;
  end;

  begin
    alter table tenant_users
      add constraint tenant_users_status_check
      check (status in ('invited','active','disabled','removed'));
  exception when others then null;
  end;

  begin
    execute 'alter table tenant_users drop constraint if exists tenant_users_auth_provider_check';
  exception when others then null;
  end;

  begin
    alter table tenant_users
      add constraint tenant_users_auth_provider_check
      check (auth_provider in ('local','google','microsoft','magic_link','system'));
  exception when others then null;
  end;
end$$;

create unique index if not exists uq_tenant_users_email
  on tenant_users(tenant_id, lower(user_email));

create index if not exists idx_tenant_users_role
  on tenant_users(tenant_id, role, status, updated_at desc);

create index if not exists idx_tenant_users_login
  on tenant_users(lower(user_email), status, tenant_id);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_tenant_users_updated_at') then
    execute '
      create trigger trg_tenant_users_updated_at
      before update on tenant_users
      for each row execute function set_updated_at();
    ';
  end if;
exception when others then null;
end$$;

-- ------------------------------------------------------------
-- auth_sessions (optional DB-backed session tracking)
-- ------------------------------------------------------------
create table if not exists auth_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_user_id uuid not null,
  tenant_id uuid not null,

  session_token_hash text not null,
  session_version int not null default 1,

  ip text,
  user_agent text,

  expires_at timestamptz not null,
  revoked_at timestamptz,

  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

alter table auth_sessions add column if not exists tenant_user_id uuid;
alter table auth_sessions add column if not exists tenant_id uuid;
alter table auth_sessions add column if not exists session_token_hash text;
alter table auth_sessions add column if not exists session_version int default 1;
alter table auth_sessions add column if not exists ip text;
alter table auth_sessions add column if not exists user_agent text;
alter table auth_sessions add column if not exists expires_at timestamptz;
alter table auth_sessions add column if not exists revoked_at timestamptz;
alter table auth_sessions add column if not exists created_at timestamptz default now();
alter table auth_sessions add column if not exists last_seen_at timestamptz;

do $$
begin
  begin
    alter table auth_sessions alter column id set default gen_random_uuid();
  exception when others then null;
  end;

  begin
    alter table auth_sessions alter column session_version set default 1;
  exception when others then null;
  end;

  begin
    alter table auth_sessions alter column created_at set default now();
  exception when others then null;
  end;

  if not exists (select 1 from pg_constraint where conname = 'auth_sessions_tenant_user_id_fkey') then
    begin
      alter table auth_sessions
        add constraint auth_sessions_tenant_user_id_fkey
        foreign key (tenant_user_id) references tenant_users(id) on delete cascade;
    exception when others then null;
    end;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'auth_sessions_tenant_id_fkey') then
    begin
      alter table auth_sessions
        add constraint auth_sessions_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete cascade;
    exception when others then null;
    end;
  end if;
end$$;

create unique index if not exists uq_auth_sessions_token_hash
  on auth_sessions(session_token_hash);

create index if not exists idx_auth_sessions_user_active
  on auth_sessions(tenant_user_id, expires_at desc)
  where revoked_at is null;

create index if not exists idx_auth_sessions_tenant_active
  on auth_sessions(tenant_id, expires_at desc)
  where revoked_at is null;

-- ------------------------------------------------------------
-- tenant_agent_configs
-- ------------------------------------------------------------
create table if not exists tenant_agent_configs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  agent_key text not null,
  display_name text not null default '',
  role_summary text not null default '',
  enabled boolean not null default true,
  model text,
  temperature numeric(4,2),
  prompt_overrides jsonb not null default '{}'::jsonb,
  tool_access jsonb not null default '{}'::jsonb,
  limits jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenant_agent_configs add column if not exists display_name text default '';
alter table tenant_agent_configs add column if not exists role_summary text default '';
alter table tenant_agent_configs add column if not exists enabled boolean default true;
alter table tenant_agent_configs add column if not exists model text;
alter table tenant_agent_configs add column if not exists temperature numeric(4,2);
alter table tenant_agent_configs add column if not exists prompt_overrides jsonb default '{}'::jsonb;
alter table tenant_agent_configs add column if not exists tool_access jsonb default '{}'::jsonb;
alter table tenant_agent_configs add column if not exists limits jsonb default '{}'::jsonb;
alter table tenant_agent_configs add column if not exists created_at timestamptz default now();
alter table tenant_agent_configs add column if not exists updated_at timestamptz default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenant_agent_configs_tenant_id_fkey') then
    begin
      alter table tenant_agent_configs
        add constraint tenant_agent_configs_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete cascade;
    exception when others then null;
    end;
  end if;
end$$;

create unique index if not exists uq_tenant_agent_configs_tenant_agent
  on tenant_agent_configs(tenant_id, agent_key);

create index if not exists idx_tenant_agent_configs_enabled
  on tenant_agent_configs(tenant_id, enabled, updated_at desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_tenant_agent_configs_updated_at') then
    execute '
      create trigger trg_tenant_agent_configs_updated_at
      before update on tenant_agent_configs
      for each row execute function set_updated_at();
    ';
  end if;
exception when others then null;
end$$;

-- ============================================================
-- threads
-- ============================================================
create table if not exists threads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  tenant_key text,
  title text,
  created_at timestamptz not null default now()
);

alter table threads add column if not exists tenant_id uuid;
alter table threads add column if not exists tenant_key text;

do $$
begin
  begin
    alter table threads alter column id set default gen_random_uuid();
  exception when others then null;
  end;

  if not exists (select 1 from pg_constraint where conname = 'threads_tenant_id_fkey') then
    begin
      alter table threads
        add constraint threads_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;

create index if not exists idx_threads_tenant_created on threads(tenant_id, created_at desc);
create index if not exists idx_threads_tenant_key_created on threads(tenant_key, created_at desc);

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
  tenant_id uuid,
  tenant_key text,
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

alter table proposals add column if not exists tenant_id uuid;
alter table proposals add column if not exists tenant_key text;
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

  if not exists (select 1 from pg_constraint where conname = 'proposals_thread_id_fkey') then
    begin
      alter table proposals
        add constraint proposals_thread_id_fkey
        foreign key (thread_id) references threads(id) on delete set null;
    exception when others then null;
    end;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'proposals_tenant_id_fkey') then
    begin
      alter table proposals
        add constraint proposals_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;

create index if not exists idx_proposals_status_created on proposals(status, created_at desc);
create index if not exists idx_proposals_tenant_status on proposals(tenant_id, status, created_at desc);
create index if not exists idx_proposals_tenant_key_status on proposals(tenant_key, status, created_at desc);

-- ============================================================
-- notifications
-- ============================================================
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  tenant_key text,
  recipient text not null default 'ceo',
  type text not null default 'info',
  title text not null default '',
  body text not null default '',
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

alter table notifications add column if not exists tenant_id uuid;
alter table notifications add column if not exists tenant_key text;
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

  if not exists (select 1 from pg_constraint where conname = 'notifications_tenant_id_fkey') then
    begin
      alter table notifications
        add constraint notifications_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;

create index if not exists idx_notifications_recipient_created on notifications(recipient, created_at desc);
create index if not exists idx_notifications_unread on notifications(recipient) where read_at is null;
create index if not exists idx_notifications_tenant_created on notifications(tenant_id, created_at desc);

-- ============================================================
-- jobs
-- ============================================================
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  tenant_key text,
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

alter table jobs add column if not exists tenant_id uuid;
alter table jobs add column if not exists tenant_key text;
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

  if not exists (select 1 from pg_constraint where conname = 'jobs_proposal_id_fkey') then
    begin
      alter table jobs
        add constraint jobs_proposal_id_fkey
        foreign key (proposal_id) references proposals(id) on delete set null;
    exception when others then null;
    end;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'jobs_tenant_id_fkey') then
    begin
      alter table jobs
        add constraint jobs_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;

create index if not exists idx_jobs_status_created on jobs(status, created_at desc);
create index if not exists idx_jobs_tenant_status_created on jobs(tenant_id, status, created_at desc);

-- ============================================================
-- audit_log
-- ============================================================
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  tenant_key text,
  actor text not null default 'system',
  action text not null,
  object_type text not null default 'unknown',
  object_id text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table audit_log add column if not exists tenant_id uuid;
alter table audit_log add column if not exists tenant_key text;
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

  if not exists (select 1 from pg_constraint where conname = 'audit_log_tenant_id_fkey') then
    begin
      alter table audit_log
        add constraint audit_log_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;

create index if not exists idx_audit_created on audit_log(created_at desc);
create index if not exists idx_audit_action on audit_log(action, created_at desc);
create index if not exists idx_audit_tenant_created on audit_log(tenant_id, created_at desc);
create index if not exists idx_audit_object_lookup
  on audit_log(object_type, object_id, created_at desc);

-- ============================================================
-- push_subscriptions
-- ============================================================
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  tenant_key text,
  recipient text not null default 'ceo',
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

alter table push_subscriptions add column if not exists tenant_id uuid;
alter table push_subscriptions add column if not exists tenant_key text;
alter table push_subscriptions add column if not exists id uuid;
alter table push_subscriptions add column if not exists recipient text;
alter table push_subscriptions add column if not exists endpoint text;
alter table push_subscriptions add column if not exists p256dh text;
alter table push_subscriptions add column if not exists auth text;
alter table push_subscriptions add column if not exists user_agent text;
alter table push_subscriptions add column if not exists created_at timestamptz default now();
alter table push_subscriptions add column if not exists last_seen_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'push_subscriptions_tenant_id_fkey') then
    begin
      alter table push_subscriptions
        add constraint push_subscriptions_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;

create unique index if not exists uq_push_endpoint on push_subscriptions(endpoint);
create index if not exists idx_push_recipient on push_subscriptions(recipient, created_at desc);
create index if not exists idx_push_tenant_created on push_subscriptions(tenant_id, created_at desc);

-- ============================================================
-- content_items
-- ============================================================
create table if not exists content_items (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid,
  tenant_key text not null,

  proposal_id uuid,
  thread_id uuid,
  job_id uuid,

  status text not null default 'draft.ready',
  version int not null default 1,
  content_pack jsonb not null default '{}'::jsonb,
  last_feedback text not null default '',

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

alter table content_items add column if not exists tenant_id uuid;
alter table content_items add column if not exists tenant_key text;
alter table content_items add column if not exists proposal_id uuid;
alter table content_items add column if not exists thread_id uuid;
alter table content_items add column if not exists job_id uuid;
alter table content_items add column if not exists status text;
alter table content_items add column if not exists version int;
alter table content_items add column if not exists content_pack jsonb default '{}'::jsonb;
alter table content_items add column if not exists last_feedback text;
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

  if not exists (select 1 from pg_constraint where conname = 'content_items_tenant_id_fkey') then
    begin
      alter table content_items
        add constraint content_items_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;

create index if not exists idx_content_proposal_updated on content_items(proposal_id, updated_at desc);
create index if not exists idx_content_status_updated on content_items(status, updated_at desc);
create index if not exists idx_content_tenant_status on content_items(tenant_id, status, created_at desc);
create index if not exists idx_content_tenant_key_status on content_items(tenant_key, status, created_at desc);
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

  tenant_id uuid,
  tenant_key text not null,
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

alter table inbox_threads add column if not exists tenant_id uuid;
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

  if not exists (select 1 from pg_constraint where conname = 'inbox_threads_tenant_id_fkey') then
    begin
      alter table inbox_threads
        add constraint inbox_threads_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;

drop index if exists uq_inbox_threads_external;

create unique index if not exists uq_inbox_threads_tenant_channel_external
  on inbox_threads(tenant_key, channel, external_thread_id)
  where external_thread_id is not null;

create index if not exists idx_inbox_threads_tenant_status_updated
  on inbox_threads(tenant_id, status, updated_at desc);

create index if not exists idx_inbox_threads_tenant_key_status_updated
  on inbox_threads(tenant_key, status, updated_at desc);

create index if not exists idx_inbox_threads_last_message
  on inbox_threads(last_message_at desc);

create index if not exists idx_inbox_threads_unread
  on inbox_threads(unread_count desc, updated_at desc);

create index if not exists idx_inbox_threads_handoff_active
  on inbox_threads(tenant_id, handoff_active, updated_at desc);

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
  tenant_id uuid,
  tenant_key text not null,
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

alter table inbox_messages add column if not exists tenant_id uuid;
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

  if not exists (select 1 from pg_constraint where conname = 'inbox_messages_thread_id_fkey') then
    begin
      alter table inbox_messages
        add constraint inbox_messages_thread_id_fkey
        foreign key (thread_id) references inbox_threads(id) on delete cascade;
    exception when others then null;
    end;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'inbox_messages_tenant_id_fkey') then
    begin
      alter table inbox_messages
        add constraint inbox_messages_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
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
  on inbox_messages(tenant_id, created_at desc);

create index if not exists idx_inbox_messages_tenant_key_created
  on inbox_messages(tenant_key, created_at desc);

create index if not exists idx_inbox_messages_external_lookup
  on inbox_messages(tenant_key, external_message_id, created_at desc)
  where external_message_id is not null;

-- ============================================================
-- leads
-- ============================================================
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid,
  tenant_key text not null,
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

  owner text,
  priority text not null default 'normal',
  value_azn numeric(12,2) not null default 0,
  follow_up_at timestamptz,
  next_action text,
  won_reason text,
  lost_reason text,

  extra jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table leads add column if not exists tenant_id uuid;
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
alter table leads add column if not exists owner text;
alter table leads add column if not exists priority text default 'normal';
alter table leads add column if not exists value_azn numeric(12,2) default 0;
alter table leads add column if not exists follow_up_at timestamptz;
alter table leads add column if not exists next_action text;
alter table leads add column if not exists won_reason text;
alter table leads add column if not exists lost_reason text;
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
    alter table leads alter column priority set default 'normal';
  exception when others then null;
  end;
  begin
    alter table leads alter column value_azn set default 0;
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

  begin
    execute 'update leads set priority = ''normal'' where priority is null or priority = ''''';
  exception when others then null;
  end;

  begin
    execute 'update leads set value_azn = 0 where value_azn is null';
  exception when others then null;
  end;

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

  if not exists (select 1 from pg_constraint where conname = 'leads_tenant_id_fkey') then
    begin
      alter table leads
        add constraint leads_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;

create index if not exists idx_leads_tenant_created on leads(tenant_id, created_at desc);
create index if not exists idx_leads_tenant_key_created on leads(tenant_key, created_at desc);
create index if not exists idx_leads_stage_created on leads(stage, created_at desc);
create index if not exists idx_leads_status_created on leads(status, created_at desc);
create index if not exists idx_leads_inbox_thread on leads(inbox_thread_id);
create index if not exists idx_leads_email on leads(email);
create index if not exists idx_leads_phone on leads(phone);
create index if not exists idx_leads_owner_updated on leads(owner, updated_at desc);
create index if not exists idx_leads_priority_updated on leads(priority, updated_at desc);
create index if not exists idx_leads_follow_up on leads(follow_up_at);
create index if not exists idx_leads_value on leads(value_azn desc);

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
-- lead_events
-- ============================================================
create table if not exists lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null,
  tenant_id uuid,
  tenant_key text not null,
  type text not null,
  actor text not null default 'ai_hq',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table lead_events add column if not exists tenant_id uuid;
alter table lead_events add column if not exists tenant_key text;
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
    alter table lead_events alter column actor set default 'ai_hq';
  exception when others then null;
  end;
  begin
    alter table lead_events alter column payload set default '{}'::jsonb;
  exception when others then null;
  end;

  if not exists (select 1 from pg_constraint where conname = 'lead_events_lead_id_fkey') then
    begin
      alter table lead_events
        add constraint lead_events_lead_id_fkey
        foreign key (lead_id) references leads(id) on delete cascade;
    exception when others then null;
    end;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'lead_events_tenant_id_fkey') then
    begin
      alter table lead_events
        add constraint lead_events_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;

create index if not exists idx_lead_events_lead_created on lead_events(lead_id, created_at desc);
create index if not exists idx_lead_events_tenant_created on lead_events(tenant_id, created_at desc);
create index if not exists idx_lead_events_tenant_key_created on lead_events(tenant_key, created_at desc);
create index if not exists idx_lead_events_type_created on lead_events(type, created_at desc);

-- ============================================================
-- comments
-- ============================================================
create table if not exists comments (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid,
  tenant_key text not null,
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

alter table comments add column if not exists tenant_id uuid;
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

  if not exists (select 1 from pg_constraint where conname = 'comments_tenant_id_fkey') then
    begin
      alter table comments
        add constraint comments_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;

create unique index if not exists uq_comments_tenant_channel_external_comment
  on comments(tenant_key, channel, external_comment_id);

create index if not exists idx_comments_tenant_created
  on comments(tenant_id, created_at desc);

create index if not exists idx_comments_tenant_key_created
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
-- ============================================================
create table if not exists inbox_outbound_attempts (
  id uuid primary key default gen_random_uuid(),

  message_id uuid not null,
  thread_id uuid not null,
  tenant_id uuid,
  tenant_key text not null,
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

alter table inbox_outbound_attempts add column if not exists tenant_id uuid;
alter table inbox_outbound_attempts add column if not exists tenant_key text;
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

  if not exists (select 1 from pg_constraint where conname = 'inbox_outbound_attempts_tenant_id_fkey') then
    begin
      alter table inbox_outbound_attempts
        add constraint inbox_outbound_attempts_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
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
  on inbox_outbound_attempts(tenant_id, status, created_at desc);

create index if not exists idx_inbox_outbound_attempts_tenant_key_status
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

-- ============================================================
-- tenant_id backfill from tenant_key (best effort)
-- legacy compatibility for runtime tables
-- ============================================================
do $$
begin
  begin
    update threads x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;

  begin
    update proposals x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;

  begin
    update notifications x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;

  begin
    update jobs x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;

  begin
    update audit_log x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;

  begin
    update push_subscriptions x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;

  begin
    update content_items x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;

  begin
    update inbox_threads x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;

  begin
    update inbox_messages x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;

  begin
    update leads x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;

  begin
    update lead_events x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;

  begin
    update comments x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;

  begin
    update inbox_outbound_attempts x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;
exception when others then null;
end$$;

-- ============================================================
-- seed tenant: NEOX
-- only as seed / example, not runtime default
-- ============================================================
do $$
declare
  v_tenant_id uuid;
begin
  insert into tenants (
    tenant_key,
    company_name,
    legal_name,
    industry_key,
    country_code,
    timezone,
    default_language,
    enabled_languages,
    market_region,
    plan_key,
    status,
    active,
    onboarding_completed_at
  )
  values (
    'neox',
    'NEOX',
    'NEOX',
    'technology',
    'AZ',
    'Asia/Baku',
    'az',
    '["az","en","tr","ru"]'::jsonb,
    'azerbaijan',
    'enterprise',
    'active',
    true,
    now()
  )
  on conflict (tenant_key) do update
    set company_name = excluded.company_name,
        legal_name = excluded.legal_name,
        industry_key = excluded.industry_key,
        country_code = excluded.country_code,
        timezone = excluded.timezone,
        default_language = excluded.default_language,
        enabled_languages = excluded.enabled_languages,
        market_region = excluded.market_region,
        plan_key = excluded.plan_key,
        status = excluded.status,
        active = excluded.active
  returning id into v_tenant_id;

  if v_tenant_id is null then
    select id into v_tenant_id from tenants where tenant_key = 'neox';
  end if;

  insert into tenant_profiles (
    tenant_id,
    brand_name,
    website_url,
    public_email,
    public_phone,
    audience_summary,
    services_summary,
    value_proposition,
    brand_summary,
    tone_of_voice,
    preferred_cta,
    banned_phrases,
    communication_rules,
    visual_style,
    extra_context
  )
  values (
    v_tenant_id,
    'NEOX',
    'https://neox.az',
    'info@neox.az',
    '+994518005577',
    'Azerbaijan and broader regional companies seeking AI automation, content systems, websites, and digital transformation.',
    'AI automation, SMM systems, websites, voice and chat assistants, operational dashboards, content execution.',
    'Premium AI-powered business growth and automation systems.',
    'NEOX is a premium AI automation and digital systems company.',
    'premium_modern_confident',
    'Əlaqə saxlayın',
    '[]'::jsonb,
    jsonb_build_object(
      'languages', jsonb_build_array('az','en','tr','ru'),
      'formalLevel', 'semi_formal',
      'replyStyle', 'clear_and_actionable'
    ),
    jsonb_build_object(
      'theme', 'premium_dark',
      'mood', 'futuristic_clean',
      'contrast', 'high'
    ),
    '{}'::jsonb
  )
  on conflict (tenant_id) do update
    set brand_name = excluded.brand_name,
        website_url = excluded.website_url,
        public_email = excluded.public_email,
        public_phone = excluded.public_phone,
        audience_summary = excluded.audience_summary,
        services_summary = excluded.services_summary,
        value_proposition = excluded.value_proposition,
        brand_summary = excluded.brand_summary,
        tone_of_voice = excluded.tone_of_voice,
        preferred_cta = excluded.preferred_cta,
        banned_phrases = excluded.banned_phrases,
        communication_rules = excluded.communication_rules,
        visual_style = excluded.visual_style,
        extra_context = excluded.extra_context;

  insert into tenant_ai_policies (
    tenant_id,
    auto_reply_enabled,
    suppress_ai_during_handoff,
    mark_seen_enabled,
    typing_indicator_enabled,
    create_lead_enabled,
    approval_required_content,
    approval_required_publish,
    quiet_hours_enabled,
    quiet_hours,
    inbox_policy,
    comment_policy,
    content_policy,
    escalation_rules,
    risk_rules,
    lead_scoring_rules,
    publish_policy
  )
  values (
    v_tenant_id,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
    jsonb_build_object('startHour',0,'endHour',0),
    jsonb_build_object(
      'allowedChannels', jsonb_build_array('instagram','facebook','whatsapp'),
      'handoffEnabled', true,
      'autoReleaseOnOperatorReply', false,
      'humanKeywords', jsonb_build_array(
        'operator','menecer','manager','human',
        'adamla danışım','adamla danisim',
        'real adam','zəng edin','zeng edin',
        'call me','əlaqə','elaqe'
      )
    ),
    jsonb_build_object(
      'autoReplyEnabled', true,
      'escalateToxic', true
    ),
    jsonb_build_object(
      'draftApprovalRequired', true,
      'publishApprovalRequired', true
    ),
    jsonb_build_object(
      'urgentLeadCreatesHandoff', true
    ),
    jsonb_build_object(
      'highRiskTopics', jsonb_build_array('legal','medical','financial_commitment')
    ),
    jsonb_build_object(
      'pricingIntent', 25,
      'serviceInterest', 20,
      'humanRequest', 30,
      'urgency', 20
    ),
    jsonb_build_object(
      'allowedPlatforms', jsonb_build_array('instagram')
    )
  )
  on conflict (tenant_id) do update
    set auto_reply_enabled = excluded.auto_reply_enabled,
        suppress_ai_during_handoff = excluded.suppress_ai_during_handoff,
        mark_seen_enabled = excluded.mark_seen_enabled,
        typing_indicator_enabled = excluded.typing_indicator_enabled,
        create_lead_enabled = excluded.create_lead_enabled,
        approval_required_content = excluded.approval_required_content,
        approval_required_publish = excluded.approval_required_publish,
        quiet_hours_enabled = excluded.quiet_hours_enabled,
        quiet_hours = excluded.quiet_hours,
        inbox_policy = excluded.inbox_policy,
        comment_policy = excluded.comment_policy,
        content_policy = excluded.content_policy,
        escalation_rules = excluded.escalation_rules,
        risk_rules = excluded.risk_rules,
        lead_scoring_rules = excluded.lead_scoring_rules,
        publish_policy = excluded.publish_policy;

  insert into tenant_channels (
    tenant_id,
    channel_type,
    provider,
    display_name,
    external_page_id,
    external_user_id,
    external_username,
    status,
    is_primary,
    config,
    health
  )
  values (
    v_tenant_id,
    'instagram',
    'meta',
    'NEOX Instagram',
    '1034647199727587',
    '17841473956986087',
    'neox.az',
    'connected',
    true,
    '{}'::jsonb,
    '{}'::jsonb
  )
  on conflict do nothing;

  insert into tenant_agent_configs (
    tenant_id, agent_key, display_name, role_summary, enabled, model, temperature, prompt_overrides, tool_access, limits
  ) values
    (v_tenant_id, 'orion', 'Orion', 'Strategic planner and high-level business thinker.', true, 'gpt-5', 0.40, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb),
    (v_tenant_id, 'nova',  'Nova',  'Creative and content generation specialist.', true, 'gpt-5', 0.80, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb),
    (v_tenant_id, 'atlas', 'Atlas', 'Sales, operations, CRM and inbox specialist.', true, 'gpt-5', 0.50, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb),
    (v_tenant_id, 'echo',  'Echo',  'Analytics, QA and insight specialist.', true, 'gpt-5', 0.30, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
  on conflict (tenant_id, agent_key) do update
    set display_name = excluded.display_name,
        role_summary = excluded.role_summary,
        enabled = excluded.enabled,
        model = excluded.model,
        temperature = excluded.temperature,
        prompt_overrides = excluded.prompt_overrides,
        tool_access = excluded.tool_access,
        limits = excluded.limits;

  if not exists (
    select 1 from tenant_users
    where tenant_id = v_tenant_id
      and lower(user_email) = lower('owner@neox.az')
  ) then
    insert into tenant_users (
      tenant_id,
      user_email,
      full_name,
      role,
      status,
      password_hash,
      auth_provider,
      email_verified,
      session_version,
      permissions,
      meta
    )
    values (
      v_tenant_id,
      'owner@neox.az',
      'NEOX Owner',
      'owner',
      'active',
      null,
      'local',
      true,
      1,
      '{}'::jsonb,
      '{}'::jsonb
    );
  end if;

exception when others then null;
end$$;

-- ============================================================
-- Mojibake repair (best effort)
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
-- tenant channel resolver performance indexes
-- needed for /api/tenants/resolve-channel
-- ============================================================

create index if not exists idx_tenant_channels_resolve_page
  on tenant_channels(channel_type, external_page_id, is_primary desc, updated_at desc)
  where external_page_id is not null;

create index if not exists idx_tenant_channels_resolve_user
  on tenant_channels(channel_type, external_user_id, is_primary desc, updated_at desc)
  where external_user_id is not null;

create index if not exists idx_tenant_channels_resolve_account
  on tenant_channels(channel_type, external_account_id, is_primary desc, updated_at desc)
  where external_account_id is not null;

create index if not exists idx_tenant_secrets_provider_key_active
  on tenant_secrets(tenant_id, provider, secret_key, is_active, updated_at desc);

-- ============================================================
-- VOICE MODULE
-- tenant-first voice settings / calls / call events / usage
-- ============================================================

-- ------------------------------------------------------------
-- tenant_voice_settings
-- one row per tenant
-- ------------------------------------------------------------
create table if not exists tenant_voice_settings (
  tenant_id uuid primary key,

  enabled boolean not null default false,
  provider text not null default 'twilio',
  mode text not null default 'assistant',

  display_name text not null default '',
  default_language text not null default 'az',
  supported_languages jsonb not null default '["az"]'::jsonb,

  greeting jsonb not null default '{}'::jsonb,
  fallback_greeting jsonb not null default '{}'::jsonb,
  business_context text not null default '',
  instructions text not null default '',

  business_hours_enabled boolean not null default false,
  business_hours jsonb not null default '{}'::jsonb,

  operator_enabled boolean not null default true,
  operator_phone text,
  operator_label text not null default '',
  transfer_strategy text not null default 'handoff',

  callback_enabled boolean not null default true,
  callback_mode text not null default 'lead_only',

  max_call_seconds int not null default 180,
  silence_hangup_seconds int not null default 12,

  capture_rules jsonb not null default '{}'::jsonb,
  lead_rules jsonb not null default '{}'::jsonb,
  escalation_rules jsonb not null default '{}'::jsonb,
  reporting_rules jsonb not null default '{}'::jsonb,

  twilio_phone_number text,
  twilio_phone_sid text,
  twilio_config jsonb not null default '{}'::jsonb,

  cost_control jsonb not null default '{}'::jsonb,
  meta jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenant_voice_settings add column if not exists tenant_id uuid;
alter table tenant_voice_settings add column if not exists enabled boolean default false;
alter table tenant_voice_settings add column if not exists provider text default 'twilio';
alter table tenant_voice_settings add column if not exists mode text default 'assistant';
alter table tenant_voice_settings add column if not exists display_name text default '';
alter table tenant_voice_settings add column if not exists default_language text default 'az';
alter table tenant_voice_settings add column if not exists supported_languages jsonb default '["az"]'::jsonb;
alter table tenant_voice_settings add column if not exists greeting jsonb default '{}'::jsonb;
alter table tenant_voice_settings add column if not exists fallback_greeting jsonb default '{}'::jsonb;
alter table tenant_voice_settings add column if not exists business_context text default '';
alter table tenant_voice_settings add column if not exists instructions text default '';
alter table tenant_voice_settings add column if not exists business_hours_enabled boolean default false;
alter table tenant_voice_settings add column if not exists business_hours jsonb default '{}'::jsonb;
alter table tenant_voice_settings add column if not exists operator_enabled boolean default true;
alter table tenant_voice_settings add column if not exists operator_phone text;
alter table tenant_voice_settings add column if not exists operator_label text default '';
alter table tenant_voice_settings add column if not exists transfer_strategy text default 'handoff';
alter table tenant_voice_settings add column if not exists callback_enabled boolean default true;
alter table tenant_voice_settings add column if not exists callback_mode text default 'lead_only';
alter table tenant_voice_settings add column if not exists max_call_seconds int default 180;
alter table tenant_voice_settings add column if not exists silence_hangup_seconds int default 12;
alter table tenant_voice_settings add column if not exists capture_rules jsonb default '{}'::jsonb;
alter table tenant_voice_settings add column if not exists lead_rules jsonb default '{}'::jsonb;
alter table tenant_voice_settings add column if not exists escalation_rules jsonb default '{}'::jsonb;
alter table tenant_voice_settings add column if not exists reporting_rules jsonb default '{}'::jsonb;
alter table tenant_voice_settings add column if not exists twilio_phone_number text;
alter table tenant_voice_settings add column if not exists twilio_phone_sid text;
alter table tenant_voice_settings add column if not exists twilio_config jsonb default '{}'::jsonb;
alter table tenant_voice_settings add column if not exists cost_control jsonb default '{}'::jsonb;
alter table tenant_voice_settings add column if not exists meta jsonb default '{}'::jsonb;
alter table tenant_voice_settings add column if not exists created_at timestamptz default now();
alter table tenant_voice_settings add column if not exists updated_at timestamptz default now();

do $$
begin
  begin
    alter table tenant_voice_settings alter column enabled set default false;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column provider set default 'twilio';
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column mode set default 'assistant';
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column display_name set default '';
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column default_language set default 'az';
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column supported_languages set default '["az"]'::jsonb;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column greeting set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column fallback_greeting set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column business_context set default '';
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column instructions set default '';
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column business_hours_enabled set default false;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column business_hours set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column operator_enabled set default true;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column operator_label set default '';
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column transfer_strategy set default 'handoff';
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column callback_enabled set default true;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column callback_mode set default 'lead_only';
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column max_call_seconds set default 180;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column silence_hangup_seconds set default 12;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column capture_rules set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column lead_rules set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column escalation_rules set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column reporting_rules set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column twilio_config set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column cost_control set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column meta set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column created_at set default now();
  exception when others then null;
  end;
  begin
    alter table tenant_voice_settings alter column updated_at set default now();
  exception when others then null;
  end;

  if not exists (select 1 from pg_constraint where conname = 'tenant_voice_settings_tenant_id_fkey') then
    begin
      alter table tenant_voice_settings
        add constraint tenant_voice_settings_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete cascade;
    exception when others then null;
    end;
  end if;

  begin
    execute 'alter table tenant_voice_settings drop constraint if exists tenant_voice_settings_provider_check';
  exception when others then null;
  end;

  begin
    alter table tenant_voice_settings
      add constraint tenant_voice_settings_provider_check
      check (provider in ('twilio','sip','byoc','other'));
  exception when others then null;
  end;

  begin
    execute 'alter table tenant_voice_settings drop constraint if exists tenant_voice_settings_mode_check';
  exception when others then null;
  end;

  begin
    alter table tenant_voice_settings
      add constraint tenant_voice_settings_mode_check
      check (mode in ('assistant','ivr','hybrid','disabled'));
  exception when others then null;
  end;

  begin
    execute 'alter table tenant_voice_settings drop constraint if exists tenant_voice_settings_transfer_strategy_check';
  exception when others then null;
  end;

  begin
    alter table tenant_voice_settings
      add constraint tenant_voice_settings_transfer_strategy_check
      check (transfer_strategy in ('handoff','callback','schedule_callback','never'));
  exception when others then null;
  end;

  begin
    execute 'alter table tenant_voice_settings drop constraint if exists tenant_voice_settings_callback_mode_check';
  exception when others then null;
  end;

  begin
    alter table tenant_voice_settings
      add constraint tenant_voice_settings_callback_mode_check
      check (callback_mode in ('disabled','lead_only','always','after_hours'));
  exception when others then null;
  end;
end$$;

create index if not exists idx_tenant_voice_settings_enabled
  on tenant_voice_settings(enabled, updated_at desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_tenant_voice_settings_updated_at') then
    execute '
      create trigger trg_tenant_voice_settings_updated_at
      before update on tenant_voice_settings
      for each row execute function set_updated_at();
    ';
  end if;
exception when others then null;
end$$;

-- ------------------------------------------------------------
-- voice_calls
-- one row per completed or active call
-- ------------------------------------------------------------
create table if not exists voice_calls (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid,
  tenant_key text not null,

  provider text not null default 'twilio',
  provider_call_sid text,
  provider_stream_sid text,

  direction text not null default 'inbound',
  status text not null default 'queued',

  from_number text,
  to_number text,
  caller_name text,

  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds int not null default 0,

  language text not null default 'az',
  agent_mode text not null default 'assistant',

  handoff_requested boolean not null default false,
  handoff_completed boolean not null default false,
  handoff_target text,

  callback_requested boolean not null default false,
  callback_phone text,

  lead_id uuid,
  inbox_thread_id uuid,

  transcript text not null default '',
  summary text not null default '',
  outcome text not null default 'unknown',
  intent text,
  sentiment text,

  cost_amount numeric(12,6) not null default 0,
  cost_currency text not null default 'USD',

  metrics jsonb not null default '{}'::jsonb,
  extraction jsonb not null default '{}'::jsonb,
  meta jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table voice_calls add column if not exists tenant_id uuid;
alter table voice_calls add column if not exists tenant_key text;
alter table voice_calls add column if not exists provider text default 'twilio';
alter table voice_calls add column if not exists provider_call_sid text;
alter table voice_calls add column if not exists provider_stream_sid text;
alter table voice_calls add column if not exists direction text default 'inbound';
alter table voice_calls add column if not exists status text default 'queued';
alter table voice_calls add column if not exists from_number text;
alter table voice_calls add column if not exists to_number text;
alter table voice_calls add column if not exists caller_name text;
alter table voice_calls add column if not exists started_at timestamptz;
alter table voice_calls add column if not exists answered_at timestamptz;
alter table voice_calls add column if not exists ended_at timestamptz;
alter table voice_calls add column if not exists duration_seconds int default 0;
alter table voice_calls add column if not exists language text default 'az';
alter table voice_calls add column if not exists agent_mode text default 'assistant';
alter table voice_calls add column if not exists handoff_requested boolean default false;
alter table voice_calls add column if not exists handoff_completed boolean default false;
alter table voice_calls add column if not exists handoff_target text;
alter table voice_calls add column if not exists callback_requested boolean default false;
alter table voice_calls add column if not exists callback_phone text;
alter table voice_calls add column if not exists lead_id uuid;
alter table voice_calls add column if not exists inbox_thread_id uuid;
alter table voice_calls add column if not exists transcript text default '';
alter table voice_calls add column if not exists summary text default '';
alter table voice_calls add column if not exists outcome text default 'unknown';
alter table voice_calls add column if not exists intent text;
alter table voice_calls add column if not exists sentiment text;
alter table voice_calls add column if not exists cost_amount numeric(12,6) default 0;
alter table voice_calls add column if not exists cost_currency text default 'USD';
alter table voice_calls add column if not exists metrics jsonb default '{}'::jsonb;
alter table voice_calls add column if not exists extraction jsonb default '{}'::jsonb;
alter table voice_calls add column if not exists meta jsonb default '{}'::jsonb;
alter table voice_calls add column if not exists created_at timestamptz default now();
alter table voice_calls add column if not exists updated_at timestamptz default now();

do $$
begin
  begin
    alter table voice_calls alter column id set default gen_random_uuid();
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column provider set default 'twilio';
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column direction set default 'inbound';
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column status set default 'queued';
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column duration_seconds set default 0;
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column language set default 'az';
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column agent_mode set default 'assistant';
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column handoff_requested set default false;
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column handoff_completed set default false;
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column callback_requested set default false;
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column transcript set default '';
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column summary set default '';
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column outcome set default 'unknown';
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column cost_amount set default 0;
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column cost_currency set default 'USD';
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column metrics set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column extraction set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column meta set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column created_at set default now();
  exception when others then null;
  end;
  begin
    alter table voice_calls alter column updated_at set default now();
  exception when others then null;
  end;

  if not exists (select 1 from pg_constraint where conname = 'voice_calls_tenant_id_fkey') then
    begin
      alter table voice_calls
        add constraint voice_calls_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
    exception when others then null;
    end;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'voice_calls_lead_id_fkey') then
    begin
      alter table voice_calls
        add constraint voice_calls_lead_id_fkey
        foreign key (lead_id) references leads(id) on delete set null;
    exception when others then null;
    end;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'voice_calls_inbox_thread_id_fkey') then
    begin
      alter table voice_calls
        add constraint voice_calls_inbox_thread_id_fkey
        foreign key (inbox_thread_id) references inbox_threads(id) on delete set null;
    exception when others then null;
    end;
  end if;

  begin
    execute 'alter table voice_calls drop constraint if exists voice_calls_provider_check';
  exception when others then null;
  end;

  begin
    alter table voice_calls
      add constraint voice_calls_provider_check
      check (provider in ('twilio','sip','byoc','other'));
  exception when others then null;
  end;

  begin
    execute 'alter table voice_calls drop constraint if exists voice_calls_direction_check';
  exception when others then null;
  end;

  begin
    alter table voice_calls
      add constraint voice_calls_direction_check
      check (direction in ('inbound','outbound','callback','internal_test'));
  exception when others then null;
  end;

  begin
    execute 'alter table voice_calls drop constraint if exists voice_calls_status_check';
  exception when others then null;
  end;

  begin
    alter table voice_calls
      add constraint voice_calls_status_check
      check (status in ('queued','ringing','in_progress','completed','failed','busy','no_answer','canceled'));
  exception when others then null;
  end;

  begin
    execute 'alter table voice_calls drop constraint if exists voice_calls_agent_mode_check';
  exception when others then null;
  end;

  begin
    alter table voice_calls
      add constraint voice_calls_agent_mode_check
      check (agent_mode in ('assistant','ivr','human','hybrid'));
  exception when others then null;
  end;

  begin
    execute 'alter table voice_calls drop constraint if exists voice_calls_outcome_check';
  exception when others then null;
  end;

  begin
    alter table voice_calls
      add constraint voice_calls_outcome_check
      check (outcome in (
        'unknown',
        'lead_captured',
        'handoff_completed',
        'callback_requested',
        'faq_resolved',
        'missed',
        'spam',
        'failed'
      ));
  exception when others then null;
  end;
end$$;

create unique index if not exists uq_voice_calls_provider_call_sid
  on voice_calls(provider, provider_call_sid)
  where provider_call_sid is not null;

create index if not exists idx_voice_calls_tenant_created
  on voice_calls(tenant_id, created_at desc);

create index if not exists idx_voice_calls_tenant_key_created
  on voice_calls(tenant_key, created_at desc);

create index if not exists idx_voice_calls_status_started
  on voice_calls(status, started_at desc);

create index if not exists idx_voice_calls_lead
  on voice_calls(lead_id, created_at desc);

create index if not exists idx_voice_calls_thread
  on voice_calls(inbox_thread_id, created_at desc);

create index if not exists idx_voice_calls_from_number
  on voice_calls(from_number, created_at desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_voice_calls_updated_at') then
    execute '
      create trigger trg_voice_calls_updated_at
      before update on voice_calls
      for each row execute function set_updated_at();
    ';
  end if;
exception when others then null;
end$$;

-- ------------------------------------------------------------
-- voice_call_events
-- timeline / audit for each call
-- ------------------------------------------------------------
create table if not exists voice_call_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null,
  tenant_id uuid,
  tenant_key text not null,
  event_type text not null,
  actor text not null default 'system',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table voice_call_events add column if not exists tenant_id uuid;
alter table voice_call_events add column if not exists tenant_key text;
alter table voice_call_events add column if not exists event_type text;
alter table voice_call_events add column if not exists actor text default 'system';
alter table voice_call_events add column if not exists payload jsonb default '{}'::jsonb;
alter table voice_call_events add column if not exists created_at timestamptz default now();

do $$
begin
  begin
    alter table voice_call_events alter column id set default gen_random_uuid();
  exception when others then null;
  end;
  begin
    alter table voice_call_events alter column actor set default 'system';
  exception when others then null;
  end;
  begin
    alter table voice_call_events alter column payload set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table voice_call_events alter column created_at set default now();
  exception when others then null;
  end;

  if not exists (select 1 from pg_constraint where conname = 'voice_call_events_call_id_fkey') then
    begin
      alter table voice_call_events
        add constraint voice_call_events_call_id_fkey
        foreign key (call_id) references voice_calls(id) on delete cascade;
    exception when others then null;
    end;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'voice_call_events_tenant_id_fkey') then
    begin
      alter table voice_call_events
        add constraint voice_call_events_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
    exception when others then null;
    end;
  end if;
end$$;

create index if not exists idx_voice_call_events_call_created
  on voice_call_events(call_id, created_at asc);

create index if not exists idx_voice_call_events_tenant_created
  on voice_call_events(tenant_id, created_at desc);

create index if not exists idx_voice_call_events_type_created
  on voice_call_events(event_type, created_at desc);

-- ------------------------------------------------------------
-- voice_daily_usage
-- daily usage & cost aggregation
-- ------------------------------------------------------------
create table if not exists voice_daily_usage (
  id uuid primary key default gen_random_uuid(),

  tenant_id uuid,
  tenant_key text not null,
  usage_date date not null,

  provider text not null default 'twilio',

  call_count int not null default 0,
  inbound_count int not null default 0,
  outbound_count int not null default 0,

  total_duration_seconds int not null default 0,
  total_cost_amount numeric(12,6) not null default 0,
  cost_currency text not null default 'USD',

  metrics jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table voice_daily_usage add column if not exists tenant_id uuid;
alter table voice_daily_usage add column if not exists tenant_key text;
alter table voice_daily_usage add column if not exists usage_date date;
alter table voice_daily_usage add column if not exists provider text default 'twilio';
alter table voice_daily_usage add column if not exists call_count int default 0;
alter table voice_daily_usage add column if not exists inbound_count int default 0;
alter table voice_daily_usage add column if not exists outbound_count int default 0;
alter table voice_daily_usage add column if not exists total_duration_seconds int default 0;
alter table voice_daily_usage add column if not exists total_cost_amount numeric(12,6) default 0;
alter table voice_daily_usage add column if not exists cost_currency text default 'USD';
alter table voice_daily_usage add column if not exists metrics jsonb default '{}'::jsonb;
alter table voice_daily_usage add column if not exists created_at timestamptz default now();
alter table voice_daily_usage add column if not exists updated_at timestamptz default now();

do $$
begin
  begin
    alter table voice_daily_usage alter column id set default gen_random_uuid();
  exception when others then null;
  end;
  begin
    alter table voice_daily_usage alter column provider set default 'twilio';
  exception when others then null;
  end;
  begin
    alter table voice_daily_usage alter column call_count set default 0;
  exception when others then null;
  end;
  begin
    alter table voice_daily_usage alter column inbound_count set default 0;
  exception when others then null;
  end;
  begin
    alter table voice_daily_usage alter column outbound_count set default 0;
  exception when others then null;
  end;
  begin
    alter table voice_daily_usage alter column total_duration_seconds set default 0;
  exception when others then null;
  end;
  begin
    alter table voice_daily_usage alter column total_cost_amount set default 0;
  exception when others then null;
  end;
  begin
    alter table voice_daily_usage alter column cost_currency set default 'USD';
  exception when others then null;
  end;
  begin
    alter table voice_daily_usage alter column metrics set default '{}'::jsonb;
  exception when others then null;
  end;
  begin
    alter table voice_daily_usage alter column created_at set default now();
  exception when others then null;
  end;
  begin
    alter table voice_daily_usage alter column updated_at set default now();
  exception when others then null;
  end;

  if not exists (select 1 from pg_constraint where conname = 'voice_daily_usage_tenant_id_fkey') then
    begin
      alter table voice_daily_usage
        add constraint voice_daily_usage_tenant_id_fkey
        foreign key (tenant_id) references tenants(id) on delete set null;
    exception when others then null;
    end;
  end if;

  begin
    execute 'alter table voice_daily_usage drop constraint if exists voice_daily_usage_provider_check';
  exception when others then null;
  end;

  begin
    alter table voice_daily_usage
      add constraint voice_daily_usage_provider_check
      check (provider in ('twilio','sip','byoc','other'));
  exception when others then null;
  end;
end$$;

create unique index if not exists uq_voice_daily_usage_tenant_provider_date
  on voice_daily_usage(tenant_id, provider, usage_date);

create index if not exists idx_voice_daily_usage_tenant_date
  on voice_daily_usage(tenant_id, usage_date desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_voice_daily_usage_updated_at') then
    execute '
      create trigger trg_voice_daily_usage_updated_at
      before update on voice_daily_usage
      for each row execute function set_updated_at();
    ';
  end if;
exception when others then null;
end$$;

-- ============================================================
-- tenant_id backfill for voice tables
-- ============================================================
do $$
begin
  begin
    update voice_calls x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;

  begin
    update voice_call_events x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;

  begin
    update voice_daily_usage x
    set tenant_id = t.id
    from tenants t
    where x.tenant_id is null
      and x.tenant_key is not null
      and t.tenant_key = x.tenant_key;
  exception when others then null;
  end;
exception when others then null;
end$$;

-- ============================================================
-- seed voice settings for NEOX
-- ============================================================
do $$
declare
  v_tenant_id uuid;
begin
  select id into v_tenant_id
  from tenants
  where tenant_key = 'neox'
  limit 1;

  if v_tenant_id is not null then
    insert into tenant_voice_settings (
      tenant_id,
      enabled,
      provider,
      mode,
      display_name,
      default_language,
      supported_languages,
      greeting,
      fallback_greeting,
      business_context,
      instructions,
      business_hours_enabled,
      business_hours,
      operator_enabled,
      operator_phone,
      operator_label,
      transfer_strategy,
      callback_enabled,
      callback_mode,
      max_call_seconds,
      silence_hangup_seconds,
      capture_rules,
      lead_rules,
      escalation_rules,
      reporting_rules,
      twilio_phone_number,
      twilio_config,
      cost_control,
      meta
    )
    values (
      v_tenant_id,
      true,
      'twilio',
      'assistant',
      'NEOX Voice Agent',
      'az',
      '["az","en","tr","ru"]'::jsonb,
      jsonb_build_object(
        'az', 'Salam, mən NEOX şirkətinin virtual asistentiyəm. Sizə necə kömək edə bilərəm?',
        'en', 'Hello, I am the virtual assistant of NEOX. How can I help you?',
        'tr', 'Salam, ben NEOX şirketinin sanal asistanıyım. Size nasıl yardımcı olabilirim?',
        'ru', 'Здравствуйте, я виртуальный ассистент компании NEOX. Чем могу помочь?'
      ),
      jsonb_build_object(
        'az', 'Hazırda səsli xidmət əlçatan deyil. Zəhmət olmasa əlaqə nömrənizi qeyd edin.',
        'en', 'Voice service is currently unavailable. Please leave your contact number.',
        'tr', 'Sesli hizmet şu anda kullanılamıyor. Lütfen iletişim numaranızı bırakın.',
        'ru', 'Голосовой сервис сейчас недоступен. Пожалуйста, оставьте свой номер.'
      ),
      'NEOX provides AI automation, websites, AI assistants, and digital growth systems for businesses.',
      '',
      false,
      '{}'::jsonb,
      true,
      '+994518005577',
      'Sales Operator',
      'handoff',
      true,
      'lead_only',
      180,
      12,
      jsonb_build_object(
        'collectName', true,
        'collectPhone', true,
        'collectServiceInterest', true,
        'collectPreferredCallbackTime', true
      ),
      jsonb_build_object(
        'autoCreateLead', true,
        'minIntentScore', 40
      ),
      jsonb_build_object(
        'humanKeywords', jsonb_build_array(
          'operator','menecer','manager','human',
          'adamla danışım','adamla danisim',
          'real adam','zəng edin','zeng edin',
          'call me','əlaqə','elaqe'
        )
      ),
      jsonb_build_object(
        'storeTranscript', true,
        'storeSummary', true,
        'notifyOnLead', true,
        'notifyOnMissed', true
      ),
      null,
      '{}'::jsonb,
      jsonb_build_object(
        'dailySoftLimitUsd', 10,
        'monthlySoftLimitUsd', 150,
        'warnAtPercent', 80
      ),
      '{}'::jsonb
    )
    on conflict (tenant_id) do update
      set enabled = excluded.enabled,
          provider = excluded.provider,
          mode = excluded.mode,
          display_name = excluded.display_name,
          default_language = excluded.default_language,
          supported_languages = excluded.supported_languages,
          greeting = excluded.greeting,
          fallback_greeting = excluded.fallback_greeting,
          business_context = excluded.business_context,
          operator_enabled = excluded.operator_enabled,
          operator_phone = excluded.operator_phone,
          operator_label = excluded.operator_label,
          transfer_strategy = excluded.transfer_strategy,
          callback_enabled = excluded.callback_enabled,
          callback_mode = excluded.callback_mode,
          max_call_seconds = excluded.max_call_seconds,
          silence_hangup_seconds = excluded.silence_hangup_seconds,
          capture_rules = excluded.capture_rules,
          lead_rules = excluded.lead_rules,
          escalation_rules = excluded.escalation_rules,
          reporting_rules = excluded.reporting_rules,
          cost_control = excluded.cost_control,
          updated_at = now();
  end if;
exception when others then null;
end$$;