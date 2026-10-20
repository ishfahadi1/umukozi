-- Replay protection for the admin authenticator code: a 30-second step can be used only once.
alter table public.admins add column if not exists last_step bigint not null default -1;
