-- The admin's secrets (authenticator secret, PIN hash, lockout counters) are only for the totp edge function (service role).
-- Browser clients (anon / authenticated) may read and edit only the harmless profile columns of their own row.
revoke all on table public.admins from anon, authenticated;
grant select (id, name, photo_url, notif_signups, notif_payments, notif_hired, created_at) on public.admins to authenticated;
grant update (name, photo_url, notif_signups, notif_payments, notif_hired) on public.admins to authenticated;
