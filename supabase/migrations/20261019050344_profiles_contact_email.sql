-- The email the person typed at signup, used for payment billing and receipts. Login still uses the phone number.
alter table public.profiles add column if not exists contact_email text;
