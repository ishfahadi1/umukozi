-- The Pesapal IPN id is kept per environment (sandbox or live), so switching PESAPAL_ENV needs no manual reset.
alter table public.settings add column if not exists pesapal_ipn_env text;
update public.settings set pesapal_ipn_env = 'sandbox' where pesapal_ipn_id is not null and pesapal_ipn_env is null;
