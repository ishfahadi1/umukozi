# XentriPAY: the only payment provider

Every payment in Umukozi (sign-up fee, reactivation, boost) goes through XentriPAY. There is one button, "Kwishyura". The customer is sent to XentriPAY's checkout page, chooses MTN MoMo or card there, and comes back to `APP_URL/?xp=<payment id>`.

Pesapal, Flutterwave and the old simulated payment function have been removed from the code (`pay`, `pesapal-ipn`, `flw-webhook`).

## Edge functions
- `xentripay` (verify_jwt **on**): `options`, `checkout_create`, `status` (and `initiate`, a direct MoMo prompt, only when `XENTRIPAY_MOMO=on`).
- `xentripay-webhook` (verify_jwt **off**): receives XentriPAY events. Every request must carry a valid `X-Xentripay-Signature` (HMAC-SHA256 of the raw body with `XENTRIPAY_WEBHOOK_SECRET`). The body is never trusted: the payment is looked up, the real status is fetched from XentriPAY with our key, and a payment is PAID only on a provider success.

## Supabase secrets
- `XENTRIPAY_API_KEY` (required)
- `XENTRIPAY_ENV`: `live` for real money; anything else uses the test host
- `XENTRIPAY_WEBHOOK_SECRET` (required for the webhook to accept anything)
- `APP_URL` (optional, default `https://umukozi.ishfadi.com`)
- `XENTRIPAY_MOMO` (optional, `on` enables direct MoMo prompts; the app does not use it)
- `XENTRIPAY_CHECKOUT` is no longer needed: checkout is on whenever the API key is set.

## Webhook
URL: `https://qwashsolakckqgdnuzrs.supabase.co/functions/v1/xentripay-webhook` (no token in the URL). Events: `COLLECTION_*` and `CHECKOUT_*`.

## Rules that never change
- The amount is decided on the server from `settings` and `categories`, never taken from the app.
- A payment is PAID only when XentriPAY reports success (webhook re-checked, or status endpoint).
- Currency must be RWF.

## First test (do this before telling users)
1. Make one checkout payment of the smallest fee.
2. Read the webhook body in the function logs: confirm which field carries the reference (session id, refid or customerRef). The code matches on all three.
3. Confirm the profile became AVAILABLE and the payment row is PAID.

## Tests
`node tests/xentripay.logic.test.mjs` (no network).

## Checkout page host
XentriPAY returns a `checkoutUrl`. If it points to a different XentriPAY site than the one that created the session (for example the sandbox API returning a link on `xentripay.com`), the page shows "Failed to load checkout session" and amount 0. `xentripay` now moves such a link to the same host as the API. To force a host, set the optional secret `XENTRIPAY_CHECKOUT_HOST` (for example `https://merchant.test.xentripay.com`). Each checkout is logged as `api=<host> given=<host> using=<host>`.
