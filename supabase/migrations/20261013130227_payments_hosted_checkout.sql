-- Flutterwave hosted checkout (card + Rwanda mobile money) records payments under provider 'flutterwave'.
alter table public.payments drop constraint if exists payments_provider_check;
alter table public.payments add constraint payments_provider_check check (provider in ('mtn','airtel','flutterwave'));
