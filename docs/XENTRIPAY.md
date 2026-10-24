# XentriPAY (MTN MoMo and Airtel Money collections)

Status: the code is deployed but switched off. It stays off until XentriPAY gives us an API key and confirms the mobile money methods for merchant 381.

## What is deployed
- `xentripay` (verify_jwt on): `options` reports whether MoMo is available; `initiate` starts a collection; `status` checks it with XentriPAY.
- `xentripay-webhook` (verify_jwt off): receives XentriPAY notifications. It refuses everything unless the URL carries the secret token. The body is never trusted: the reference is read from it, then the real status is fetched from XentriPAY using our key.
- Card payments are unchanged and stay on Pesapal.

## Supabase secrets (set in the dashboard, never in code or chat)
- `XENTRIPAY_API_KEY`: the secret API key from the merchant dashboard (not yet issued).
- `XENTRIPAY_ENV`: `test` or `live`. Anything other than `live` uses the test host.
- `XENTRIPAY_MOMO`: set to `on` only after XentriPAY confirms `momo` for merchant 381.
- `XENTRIPAY_WEBHOOK_TOKEN`: any long random string we choose. The webhook URL must end with `?token=<this value>`.

## Webhook URL to give XentriPAY
`https://qwashsolakckqgdnuzrs.supabase.co/functions/v1/xentripay-webhook?token=<XENTRIPAY_WEBHOOK_TOKEN>`

## Still unknown (ask XentriPAY, do not guess)
1. The shape of the `GET /api/collections/status/{refid}` response: which field holds the status, and whether it returns the amount and currency. Until this is known, a payment is never marked PAID. This is deliberate.
2. Whether `initiate` needs our own reference in a field. The spec only says the status endpoint accepts it.
3. Webhook signature, if they sign events at all. Not required for safety here, because we re-check status with our key.
4. Fees, settlement timing, and whether `cc` should also move from Pesapal.
5. The legal entity on the contract. Their terms say "Xentripay, Inc.", while the licence is held by Centrika Limited.

## Tests
`node tests/xentripay.logic.test.mjs` covers the decision rules (a payment is PAID only with a provider success, a covering amount and RWF), phone formats, boost plans, the webhook token and reference lookup. These are unit tests with no network.

## Turning it on, in order
1. Set `XENTRIPAY_API_KEY` and `XENTRIPAY_WEBHOOK_TOKEN`, with `XENTRIPAY_ENV=test`.
2. Give XentriPAY the webhook URL above.
3. Test one collection in test mode. Check the status response shape and fix the status mapping if needed.
4. Set `XENTRIPAY_MOMO=on`, and only then add the MoMo option to the front end.
5. Only after a live verification, switch `XENTRIPAY_ENV=live`.
