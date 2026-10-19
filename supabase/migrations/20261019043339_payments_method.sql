-- The payment method Pesapal reports (for example CARD or MTN), kept for the money view.
alter table public.payments add column if not exists payment_method text;
