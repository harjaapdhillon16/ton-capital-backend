alter table if exists deposits
  add column if not exists quoted_ton_amount numeric,
  add column if not exists quoted_ton_price_usd numeric;

