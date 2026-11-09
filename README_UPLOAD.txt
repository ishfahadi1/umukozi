UMUKOZI - GitHub upload (repo ishfahadi1/umukozi) - release v14

1) MUST upload (these change the live site; Netlify publishes automatically). Replace the old ones:
   index.html   -> /index.html
   admin.html   -> /admin.html
   sw.js        -> /sw.js      (version umukozi-2026-11-08-v14; makes phones fetch the new files)
   This release INCLUDES everything from v13 (admin->front sync, referral tab, per-category fees, EN/RW switch,
   four-section admin, AI scheduler, dark toggles) - you do not need v13 separately.

2) Copies for the repo (already LIVE in Supabase, upload only so GitHub matches; the site works without them):
   supabase/migrations/20261107*.sql          -> /supabase/migrations/
   supabase/functions/account/index.ts        -> /supabase/functions/account/index.ts   (already deployed, v36)
   docs/MARKET_ROLES.md, README.md            -> /docs/MARKET_ROLES.md, /README.md

3) NOT yet live - needs your OK:
   supabase/functions/xentripay/index.ts      -> multi-role pricing and "add roles" payments.
   The live version (v34) prices only ONE role (the first one) and rejects "add roles" payments (nothing_to_pay).
   So until it is deployed: a signup with several roles pays the single-role price, and adding roles later cannot be paid.
   Tell Claude "deploy xentripay" (the last deploy attempt was blocked by the permission check, it needs your explicit OK).

4) After the new site is live (live /sw.js shows v14) tell Claude "phase B":
   supabase/pending/phase_b_lock_profiles_public_read.sql closes the old public read of the profiles table, so
   phone numbers cannot be read directly with the public key. DO NOT run it before the new site is live.
