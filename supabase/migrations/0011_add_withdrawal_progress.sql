alter table if exists withdrawals
  add column if not exists progress jsonb not null default '[]'::jsonb;

