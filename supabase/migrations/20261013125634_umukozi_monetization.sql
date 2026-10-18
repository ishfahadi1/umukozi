-- UMUKOZI monetization: per-category fees, boosting, 2-level referral, payouts.
-- Additive. Run once in Supabase > SQL Editor.

-- 1. Sign-up fee per worker category; employer flat 500
alter table public.categories add column if not exists fee numeric not null default 500;
update public.categories set fee = 1000 where name in ('Umushoferi','Umwarimu wo murugo');
update public.categories set fee = 500  where name in ('Ukora amasuku','Urera abana','Umuzamu');
update public.settings set fee_employer = 500;

-- 2. Boost prices + referral rewards (editable)
alter table public.settings
  add column if not exists boost_prices jsonb not null default '{"2":300,"7":500,"30":1000}'::jsonb,
  add column if not exists ref_l1 numeric not null default 100,
  add column if not exists ref_l2 numeric not null default 50,
  add column if not exists min_payout numeric not null default 1000;

-- 3. Profiles: referral code, referrer, boost expiry
alter table public.profiles
  add column if not exists referral_code text,
  add column if not exists referred_by uuid references public.profiles(id) on delete set null,
  add column if not exists boosted_until timestamptz;
update public.profiles set referral_code = upper(substr(md5(id::text || random()::text),1,7)) where referral_code is null;
alter table public.profiles alter column referral_code set default upper(substr(md5(random()::text || clock_timestamp()::text),1,7));
alter table public.profiles alter column referral_code set not null;
create unique index if not exists profiles_referral_code_key on public.profiles(referral_code);
create index if not exists profiles_referred_by_idx on public.profiles(referred_by);
create index if not exists profiles_boosted_idx on public.profiles(boosted_until);

-- users cannot edit these themselves
create or replace function public.uk_guard_profile() returns trigger language plpgsql as $$
declare claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  if claims is null or coalesce(claims->>'role','') = 'service_role' then return new; end if;
  if (select private.is_admin()) then return new; end if;
  new.id := old.id; new.role := old.role; new.pay_status := old.pay_status;
  new.suspended := old.suspended; new.created_at := old.created_at;
  new.referral_code := old.referral_code; new.referred_by := old.referred_by; new.boosted_until := old.boosted_until;
  if old.status = 'HIRED' and new.status = 'AVAILABLE' then new.status := 'HIRED'; end if;
  return new;
end $$;

-- 4. Payments: boost purpose
alter table public.payments drop constraint if exists payments_purpose_check;
alter table public.payments add constraint payments_purpose_check check (purpose in ('activation','reactivation','boost'));
alter table public.payments add column if not exists boost_days int;

-- 5. Referral earnings (2 levels) and payout requests
create table if not exists public.referral_earnings (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete cascade,
  earner_id uuid not null references public.profiles(id) on delete cascade,
  source_id uuid not null references public.profiles(id) on delete cascade,
  level int not null check (level in (1,2)),
  amount numeric not null check (amount >= 0),
  created_at timestamptz not null default now(),
  unique (payment_id, level)
);
create index if not exists referral_earnings_earner_idx on public.referral_earnings(earner_id);
alter table public.referral_earnings enable row level security;
drop policy if exists referral_earnings_read on public.referral_earnings;
create policy referral_earnings_read on public.referral_earnings for select
  using (earner_id = (select auth.uid()) or (select private.is_admin()));

create table if not exists public.payout_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric not null check (amount > 0),
  provider text not null check (provider in ('mtn','airtel')),
  phone text not null,
  status text not null default 'PENDING' check (status in ('PENDING','PAID','REJECTED')),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists payout_requests_profile_idx on public.payout_requests(profile_id);
alter table public.payout_requests enable row level security;
drop policy if exists payout_read on public.payout_requests;
create policy payout_read on public.payout_requests for select
  using (profile_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists payout_admin_update on public.payout_requests;
create policy payout_admin_update on public.payout_requests for update
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- 6. Payment confirmed -> activate / boost / pay referral rewards
create or replace function public.uk_log_payment() returns trigger
language plpgsql security definer set search_path = public as $$
declare s settings%rowtype; r1 uuid; r2 uuid;
begin
  if new.status = 'PAID' and old.status is distinct from new.status then
    if new.purpose = 'boost' then
      update profiles
         set boosted_until = greatest(coalesce(boosted_until, now()), now()) + make_interval(days => coalesce(new.boost_days,0))
       where id = new.profile_id;
    else
      update profiles set pay_status='PAID', status='AVAILABLE' where id = new.profile_id;
      if new.purpose = 'activation' then
        select * into s from settings where id = true;
        select referred_by into r1 from profiles where id = new.profile_id;
        if r1 is not null and exists (select 1 from profiles where id=r1 and pay_status='PAID' and not suspended) then
          insert into referral_earnings(payment_id, earner_id, source_id, level, amount)
          values (new.id, r1, new.profile_id, 1, least(s.ref_l1, new.amount)) on conflict do nothing;
          select referred_by into r2 from profiles where id = r1;
          if r2 is not null and exists (select 1 from profiles where id=r2 and pay_status='PAID' and not suspended) then
            insert into referral_earnings(payment_id, earner_id, source_id, level, amount)
            values (new.id, r2, new.profile_id, 2, least(s.ref_l2, greatest(new.amount - s.ref_l1, 0))) on conflict do nothing;
          end if;
        end if;
      end if;
    end if;
    insert into feed_events(kind,message,profile_id)
      select 'p', (case when new.purpose='boost' then 'Boost: ' else 'Kwishyura: ' end) || p.name, p.id
        from profiles p where p.id = new.profile_id;
  elsif new.status = 'REJECTED' and old.status is distinct from new.status and new.purpose <> 'boost' then
    update profiles set pay_status='REJECTED' where id = new.profile_id and pay_status <> 'PAID';
  end if;
  return new;
end $$;

-- 7. Atomic withdrawal request (no double-spend)
create or replace function public.request_payout(p_uid uuid, p_provider text, p_phone text)
returns numeric language plpgsql security definer set search_path = public as $$
declare earned numeric; used numeric; bal numeric; minp numeric;
begin
  perform pg_advisory_xact_lock(hashtext(p_uid::text));
  select coalesce(sum(amount),0) into earned from referral_earnings where earner_id = p_uid;
  select coalesce(sum(amount),0) into used from payout_requests where profile_id = p_uid and status in ('PENDING','PAID');
  select min_payout into minp from settings where id = true;
  bal := earned - used;
  if bal < minp then raise exception 'below_minimum'; end if;
  insert into payout_requests(profile_id, amount, provider, phone) values (p_uid, bal, p_provider, p_phone);
  return bal;
end $$;
revoke all on function public.request_payout(uuid,text,text) from public, anon, authenticated;
grant execute on function public.request_payout(uuid,text,text) to service_role;
