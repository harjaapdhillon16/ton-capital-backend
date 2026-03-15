create table if not exists user_wallet_mnemonics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  wallet_address text not null,
  encrypted_mnemonic text not null,
  encryption_key text not null,
  iv text not null,
  auth_tag text not null,
  algorithm text not null default 'aes-256-gcm',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_wallet_mnemonics_user on user_wallet_mnemonics(user_id);
