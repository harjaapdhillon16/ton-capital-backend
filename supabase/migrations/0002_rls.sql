alter table users enable row level security;
alter table risk_profiles enable row level security;
alter table deposits enable row level security;
alter table withdrawals enable row level security;
alter table positions enable row level security;
alter table trades enable row level security;
alter table notifications enable row level security;

create policy "users can read own profile"
on users
for select
using (telegram_id = auth.jwt() ->> 'telegram_id');

create policy "users can read own risk"
on risk_profiles
for select
using (user_id in (select id from users where telegram_id = auth.jwt() ->> 'telegram_id'));

create policy "users can read own deposits"
on deposits
for select
using (user_id in (select id from users where telegram_id = auth.jwt() ->> 'telegram_id'));

create policy "users can read own withdrawals"
on withdrawals
for select
using (user_id in (select id from users where telegram_id = auth.jwt() ->> 'telegram_id'));

create policy "users can read own positions"
on positions
for select
using (user_id in (select id from users where telegram_id = auth.jwt() ->> 'telegram_id'));

create policy "users can read own trades"
on trades
for select
using (user_id in (select id from users where telegram_id = auth.jwt() ->> 'telegram_id'));

create policy "users can read own notifications"
on notifications
for select
using (user_id in (select id from users where telegram_id = auth.jwt() ->> 'telegram_id'));

-- Execution writes are performed via service role only.
