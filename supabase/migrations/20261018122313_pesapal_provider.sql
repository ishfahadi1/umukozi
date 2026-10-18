-- Pesapal (cards + MTN/Airtel). Payments can be recorded under provider 'pesapal'.
alter table public.payments drop constraint if exists payments_provider_check;
alter table public.payments add constraint payments_provider_check check (provider in ('mtn','airtel','flutterwave','pesapal'));
-- Pesapal IPN registration id (set automatically the first time a Pesapal order is made).
alter table public.settings add column if not exists pesapal_ipn_id text;
