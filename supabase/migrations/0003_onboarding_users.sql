alter table users add column if not exists display_name text;
alter table users add column if not exists onboarding_completed boolean not null default false;
alter table users add column if not exists onboarding_completed_at timestamptz;
alter table users add column if not exists onboarding_risk_level text;
alter table users add column if not exists onboarding_assets text[];
alter table users add column if not exists onboarding_payload jsonb;
alter table users add column if not exists telegram_auth_at timestamptz;
