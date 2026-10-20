# UMUKOZI

Marketplace for domestic workers and employers in Rwanda. A static front end on Netlify, with Supabase for the database, auth and edge functions.

## Layout

| Path | What it is |
|---|---|
| `index.html` | The public app (sign-up, payment, marketplace, profile, boost, referral, AI chat). |
| `admin.html` | The owner's admin page. Not indexed; opened only by the 7-tap gesture on the logo. |
| `sw.js`, `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png` | Installable app (PWA). |
| `assets/`, `favicon-*.png`, `favicon.ico` | Images and browser-tab icons. |
| `netlify.toml`, `404.html` | Hosting: the backend source is never served, admin is never indexed. |
| `supabase/migrations/` | Database changes, in order. Applied to the project in this order. |
| `supabase/functions/` | Edge functions (see below). |

## Edge functions

| Function | Login needed | Purpose |
|---|---|---|
| `account` | no (sign-up), yes (phone change) | Creates a sign-up; stores the person's own email and referral code. |
| `pay` | yes | Starts a payment: Pesapal hosted checkout (or Flutterwave fallback), and checks its status. |
| `pesapal-ipn` | no (called by Pesapal) | Pesapal's payment notifications. Re-checks the real status with Pesapal before marking a payment paid. |
| `referral` | yes | Referral summary and payout requests. |
| `ai-chat` | yes | The in-app AI assistant. Needs `ANTHROPIC_API_KEY`. |
| `log-error` | yes | Errors the app reports about itself. |
| `totp` | no (admin login) | Admin setup and login: setup code, PIN, and a 6-digit authenticator code. |
| `admin` | yes, admin only | Admin actions: delete a user, change a phone number. |
| `flw-webhook` | no (called by Flutterwave) | Flutterwave notifications, checked with a secret hash. |

## How admin login works

1. Open the app and tap the logo 7 times quickly. This opens `admin.html`.
2. First time only: enter the setup code, scan the QR code into an authenticator app, then set a 4-digit PIN and enter the 6-digit code.
3. Every later login: 4-digit PIN plus the current 6-digit code.

Safeguards: codes are accepted within 90 seconds either side, a code can be used only once (replay protection), and 5 wrong attempts lock the admin for 15 minutes. The setup code is stored only as a hash and is deleted when setup completes.

## Secrets (Supabase → Edge Functions → Secrets)

Set in Supabase only. Never commit them.

- `MOMO_MODE`: `live` for real payments. Anything else simulates payments.
- `PESAPAL_CONSUMER_KEY`, `PESAPAL_CONSUMER_SECRET`, `PESAPAL_ENV` (`sandbox` or `live`).
- `APP_URL`: the public address, default `https://umukozi.ishfadi.com`.
- `FLW_SECRET_KEY`, `FLW_WEBHOOK_HASH`: Flutterwave, used only if Pesapal is not configured.
- `ANTHROPIC_API_KEY`: the AI assistant.

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase.

## Deploying

- Front end: push to GitHub. Netlify publishes the repo root automatically.
- Database: each file in `supabase/migrations/` is applied in name order.
- Functions: deploy each folder in `supabase/functions/` with `verify_jwt` as follows: `totp`, `pesapal-ipn` and `flw-webhook` are **off**; the others are **on**.

## Status rules

- A new sign-up is `NEW` and is not shown in the marketplace.
- The payment confirmation makes the profile `AVAILABLE`. Nobody can set `AVAILABLE` without a confirmed payment.
- `HIRED` removes the profile from the marketplace until a new payment reactivates it.
