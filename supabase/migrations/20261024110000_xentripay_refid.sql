-- XentriPAY's own reference (refid) from the initiate response. provider_ref keeps our customerRef.
alter table public.payments add column if not exists provider_refid text;
