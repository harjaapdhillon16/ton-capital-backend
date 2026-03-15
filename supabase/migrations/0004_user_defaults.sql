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

insert into risk_profiles(user_id, max_loss_pct, allowed_assets, conservative_mode, updated_at)
select u.id, 20, array['crypto', 'gold'], true, now()
from users u
where not exists (
  select 1 from risk_profiles rp where rp.user_id = u.id
);
