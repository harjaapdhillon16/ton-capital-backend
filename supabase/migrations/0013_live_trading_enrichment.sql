alter table if exists users
  add column if not exists day_start_date date default current_date;

update users
set day_start_date = coalesce(day_start_date, current_date)
where day_start_date is null;

alter table if exists trades
  add column if not exists conviction_score numeric,
  add column if not exists risk_reward numeric,
  add column if not exists take_profit_pct numeric,
  add column if not exists rejection_category text,
  add column if not exists order_type text,
  add column if not exists stop_trigger_price numeric,
  add column if not exists take_trigger_price numeric,
  add column if not exists execution_meta jsonb;

alter table if exists positions
  add column if not exists base_size_9 numeric,
  add column if not exists margin_usdt numeric,
  add column if not exists open_notional_usdt numeric,
  add column if not exists last_synced_at timestamptz;

create index if not exists idx_positions_user_status_asset
  on positions(user_id, status, asset, direction);

create index if not exists idx_trades_user_created
  on trades(user_id, created_at desc);
