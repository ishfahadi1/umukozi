-- XentriPAY mobile money collections are recorded under provider 'xentripay'.
alter table public.payments drop constraint if exists payments_provider_check;
alter table public.payments add constraint payments_provider_check check (provider in ('mtn','airtel','flutterwave','pesapal','xentripay'));
