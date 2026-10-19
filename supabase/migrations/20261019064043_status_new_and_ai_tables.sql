-- 1) A new sign-up is NEW (not visible) until the payment is confirmed; then it becomes AVAILABLE.
alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles add constraint profiles_status_check check (status in ('NEW','AVAILABLE','HIRED'));
alter table public.profiles alter column status set default 'NEW';
update public.profiles set status = 'NEW' where status = 'AVAILABLE' and pay_status <> 'PAID';

-- Nobody can make a profile AVAILABLE unless it is paid (admins included). Only the payment step can do that.
create or replace function public.uk_guard_profile() returns trigger language plpgsql as $$
declare claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  if claims is null or coalesce(claims->>'role','') = 'service_role' then return new; end if;
  if new.status = 'AVAILABLE' and new.pay_status <> 'PAID' then new.status := old.status; end if;
  if (select private.is_admin()) then return new; end if;
  new.id := old.id; new.role := old.role; new.pay_status := old.pay_status;
  new.suspended := old.suspended; new.created_at := old.created_at;
  new.referral_code := old.referral_code; new.referred_by := old.referred_by; new.boosted_until := old.boosted_until;
  if old.status = 'HIRED' and new.status = 'AVAILABLE' then new.status := 'HIRED'; end if;
  return new;
end $$;

-- 2) App errors (reported by the app itself, so the AI manager can see what users run into).
create table if not exists public.app_errors (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete set null,
  source text not null default 'web' check (char_length(source) <= 20),
  path text check (char_length(path) <= 120),
  message text not null check (char_length(message) <= 500),
  details text check (char_length(details) <= 2000),
  created_at timestamptz not null default now()
);
create index if not exists app_errors_created_idx on public.app_errors(created_at desc);
alter table public.app_errors enable row level security;

-- 3) AI assistant conversations (what people ask, and the answers).
create table if not exists public.ai_logs (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null check (char_length(content) <= 4000),
  error text,
  created_at timestamptz not null default now()
);
create index if not exists ai_logs_profile_idx on public.ai_logs(profile_id, created_at desc);
alter table public.ai_logs enable row level security;

-- 4) Reports written by the AI manager for the owner (daily / weekly / alerts).
create table if not exists public.ai_reports (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('daily','weekly','alert')),
  period_start timestamptz,
  period_end timestamptz,
  body text not null,
  created_at timestamptz not null default now()
);
alter table public.ai_reports enable row level security;
