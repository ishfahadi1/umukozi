-- AI conversations are kept only in the admin page's memory, never in the database.
-- The public AI assistant is removed, so its conversation table goes too.
drop table if exists public.ai_logs;
drop table if exists public.ai_reports;
