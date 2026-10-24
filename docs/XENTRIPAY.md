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

## Dashboard steps (merchant 381)
1. **Webhook** (Settings → Webhooks). URL: `https://qwashsolakckqgdnuzrs.supabase.co/functions/v1/xentripay-webhook?token=<XENTRIPAY_WEBHOOK_TOKEN>`. Select the events `COLLECTION_SUCCESSFUL`, `COLLECTION_FAILED` and `COLLECTION_PENDING`. The form also lists `CHECKOUT_*` and `PAYOUT_*` events, which this integration does not use, so leave them unticked.
2. **Webhook token**: generate one on Windows with `[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")` and store it as `XENTRIPAY_WEBHOOK_TOKEN`. It must match the `token=` value in the URL.
3. **API key** (Settings → API Keys & Webhooks): create a key and store it as `XENTRIPAY_API_KEY`. Never paste it in chat or commit it.
4. **IP whitelisting** (Settings → IP Whitelisting): leave it empty until we know the server IPs, or the API calls may be blocked.
5. **Base URL**: the dashboard shows Environment TEST at xentripay.com, while the spec gives merchant.test.xentripay.com for test. Confirm the correct base in the API documentation file before testing.

## Turning MoMo on, in order
1. Set `XENTRIPAY_ENV=test`, `XENTRIPAY_API_KEY`, `XENTRIPAY_WEBHOOK_TOKEN`.
2. Set `XENTRIPAY_MOMO=on`. The MoMo button then appears on the payment screen. Only do this in test first.
3. Make one test collection and read the status response. Adjust the mapping if its shape differs from what the code expects.
4. Switch to `live` only after XentriPAY confirms the merchant is approved.


## Corrections after reading the official documents (v2.0 API, Webhooks Guide v1.0)
- `success` is a number (1 or 0). The first version checked `=== true`, so every accepted request would have been wrongly refused. Fixed.
- The status endpoint returns no amount. The first version required one, so payments could never be confirmed. Fixed: SUCCESS from the authenticated status endpoint is enough, and a reported amount, if any, must cover what we asked.
- `customerRef` is now sent on every collection (our payment id). It is also used for status checks.
- `chargesIncluded: true` is now sent, so the customer pays exactly the price shown in the app and the fee comes out of it. Confirm this with XentriPAY before launch; the alternative is to add the fee on top.
- Webhook signatures ARE documented: `X-Xentripay-Signature: sha256=<hex>`, HMAC-SHA256 over the raw body. The secret is returned when the webhook is registered via `POST /api/webhooks/set`. When `XENTRIPAY_WEBHOOK_SECRET` is set, every webhook must carry a valid signature.
- XentriPAY's `refid` is stored in `provider_refid`. Our `customerRef` is stored in `provider_ref`. Webhooks are matched against either one.

## Open questions for XentriPAY
1. Does the webhook `data.reference` equal the `refid` from initiate, or some other value? Matching works for both, but this should be confirmed in test.
2. Is `chargesIncluded: true` the right default for us?
3. Which webhook events does the dashboard send for a MoMo collection that the customer cancels?
