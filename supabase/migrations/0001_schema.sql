create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  telegram_id text unique not null,
  username text,
  first_name text,
  last_name text,
  display_name text,
  wallet_address text,
  trade_wallet_address text,
  onboarding_completed boolean not null default false,
  onboarding_completed_at timestamptz,
  onboarding_risk_level text,
  onboarding_assets text[],
  onboarding_payload jsonb,
  telegram_auth_at timestamptz,
  is_active boolean not null default true,
  paused boolean not null default false,
  total_balance_usdt numeric not null default 0,
  equity_usdt numeric not null default 0,
  peak_equity_usdt numeric not null default 0,
  day_start_equity_usdt numeric not null default 0,
  day_pnl_usdt numeric not null default 0,
  drawdown_pct numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists risk_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  max_loss_pct integer not null default 20,
  allowed_assets text[] not null default array['crypto'],
  conservative_mode boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  amount_usdt numeric not null,
  wallet_address text,
  destination_wallet text,
  jetton_master text,
  tx_hash text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create table if not exists user_trade_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  wallet_address text not null unique,
  wallet_version text not null default 'v4',
  public_key text not null,
  encrypted_mnemonic text not null,
  encryption_iv text not null,
  encryption_tag text not null,
  encryption_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  amount_usdt numeric not null,
  destination_wallet text not null,
  tx_hash text,
  status text not null default 'pending',
  progress jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  asset text not null,
  direction text not null,
  size_usdt numeric not null,
  leverage numeric not null,
  entry_price numeric not null,
  mark_price numeric not null,
  pnl_usdt numeric not null default 0,
  stop_loss_pct numeric not null,
  storm_position_id text,
  status text not null default 'open',
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists agent_runs (
  id uuid primary key,
  status text not null,
  error_message text,
  started_at timestamptz not null,
  finished_at timestamptz
);

create table if not exists briefings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_runs(id) on delete cascade,
  raw_data jsonb not null,
  decisions jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  run_id uuid not null references agent_runs(id) on delete cascade,
  idempotency_key text not null unique,
  asset text not null,
  action text not null,
  amount_usdt numeric not null default 0,
  position_pct numeric not null default 0,
  stop_loss_pct numeric,
  thesis text,
  invalidation text,
  explanation text,
  status text not null,
  external_id text,
  tx_hash text,
  failure_reason text,
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  run_id uuid not null references agent_runs(id) on delete cascade,
  channel text not null,
  payload jsonb not null,
  status text not null,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists fee_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  fee_type text not null,
  rate_bps integer not null,
  amount_usdt numeric not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  settled boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists system_controls (
  id integer primary key,
  trading_enabled boolean not null default true,
  max_global_exposure_usdt numeric not null default 5000,
  launch_cap_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into system_controls(id, trading_enabled)
values (1, true)
on conflict (id) do nothing;

create table if not exists agent_locks (
  lock_name text primary key,
  owner_id text not null,
  expires_at timestamptz not null
);

create or replace function acquire_agent_lock(
  p_lock_name text,
  p_owner_id text,
  p_ttl_seconds integer
) returns boolean as $$
declare
  now_ts timestamptz := now();
begin
  delete from agent_locks where expires_at < now_ts;

  insert into agent_locks(lock_name, owner_id, expires_at)
  values (p_lock_name, p_owner_id, now_ts + make_interval(secs => p_ttl_seconds))
  on conflict (lock_name) do nothing;

  return exists (
    select 1 from agent_locks where lock_name = p_lock_name and owner_id = p_owner_id
  );
end;
$$ language plpgsql security definer;

create or replace function release_agent_lock(
  p_lock_name text,
  p_owner_id text
) returns void as $$
begin
  delete from agent_locks where lock_name = p_lock_name and owner_id = p_owner_id;
end;
$$ language plpgsql security definer;

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_users_set_updated_at on users;
create trigger trg_users_set_updated_at
before update on users
for each row execute function set_updated_at();

create or replace function ensure_risk_profile_for_user()
returns trigger as $$
begin
  insert into risk_profiles(user_id, max_loss_pct, allowed_assets, conservative_mode, updated_at)
  values (new.id, 20, array['crypto', 'gold'], true, now())
  on conflict (user_id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_users_create_risk_profile on users;
create trigger trg_users_create_risk_profile
after insert on users
for each row execute function ensure_risk_profile_for_user();

create index if not exists idx_trades_user_created on trades(user_id, created_at desc);
create index if not exists idx_positions_user_status on positions(user_id, status);
create index if not exists idx_deposits_user_created on deposits(user_id, created_at desc);
create index if not exists idx_trade_wallets_user_id on user_trade_wallets(user_id);
