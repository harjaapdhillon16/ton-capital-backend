alter table users
  add column if not exists trade_wallet_address text;

alter table deposits
  add column if not exists destination_wallet text;

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

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'users'
      and column_name = 'vault_address'
  ) then
    execute '
      update users
      set trade_wallet_address = vault_address
      where trade_wallet_address is null
        and vault_address is not null
    ';
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'deposits'
      and column_name = 'vault_address'
  ) then
    execute '
      update deposits
      set destination_wallet = vault_address
      where destination_wallet is null
        and vault_address is not null
    ';
  end if;
end;
$$;

create index if not exists idx_users_trade_wallet_address on users(trade_wallet_address);
create index if not exists idx_trade_wallets_user_id on user_trade_wallets(user_id);
