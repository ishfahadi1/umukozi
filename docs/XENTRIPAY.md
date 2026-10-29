# XentriPAY: the only payment provider

Every payment in Umukozi (sign-up fee, reactivation, boost) goes through XentriPAY, and only through the `xentripay` function. There is one button, "Kwishyura".

## Payment flow
1. The app calls the Edge Function `xentripay` with `action: checkout_create` (login required). The amount is never sent by the app: the server works it out from `settings` and `categories`.
2. The function saves a `PENDING` payment row (provider `xentripay`, our reference in `provider_ref`), then calls `POST <API host>/api/checkout/sessions` with the `X-XENTRIPAY-KEY` header, `currency: RWF` and `customerFinalUrl = <site>/?xp=<payment id>`.
3. XentriPAY answers with a session id and a `checkoutUrl`. The id is saved in `provider_refid`.
4. The function checks the link (`inspectCheckoutUrl` in `logic.mjs`): https, a `xentripay.com` host, and not a login or dashboard page. **The link is never rewritten and never guessed.** If it fails the check, the payment is marked `REJECTED`, nothing is sent to the customer, and the app shows an error.
5. The app checks the link again (`xpSafeUrl` in `index.html`) and only then redirects the customer.
6. The customer pays on XentriPAY's page and comes back to `/?xp=<payment id>`. The app asks `xentripay` (`action: status`) until the payment is `PAID` or failed.
7. `xentripay-webhook` also receives XentriPAY events. It needs a valid HMAC signature, and it re-checks the real status with XentriPAY before marking a payment `PAID`.

## Edge functions
- `xentripay` (verify_jwt **on**): `options`, `checkout_create`, `status`, and `initiate` (direct MoMo prompt, only when `XENTRIPAY_MOMO=on`; the app does not use it).
- `xentripay-webhook` (verify_jwt **off**).

Pesapal, Flutterwave and the old simulated payment function are removed from the code (`pay`, `pesapal-ipn`, `flw-webhook`). Old migrations and old payment rows are kept on purpose.

## Supabase secrets (exactly the names the code reads)
| Name | Used by | Meaning |
|---|---|---|
| `XENTRIPAY_API_KEY` | both | Required. The key must belong to the same environment as `XENTRIPAY_ENV`. |
| `XENTRIPAY_ENV` | both | `live` uses `https://xentripay.com`. Anything else uses `https://merchant.test.xentripay.com`. |
| `XENTRIPAY_WEBHOOK_SECRET` | webhook | Required, or every webhook is refused. |
| `APP_URL` | `xentripay` | Optional, default `https://umukozi.ishfadi.com`. |
| `XENTRIPAY_MOMO` | `xentripay` | Optional, `on` enables `initiate`. |

`XENTRIPAY_CHECKOUT` and `XENTRIPAY_CHECKOUT_HOST` are not read by any code. Remove them if they exist. Never put a key in Git or in chat.

## The merchant-login redirect (found 2026-10-28)
Function logs showed `api=merchant.test.xentripay.com given=xentripay.com using=merchant.test.xentripay.com`. XentriPAY's sandbox API returned a checkout link on `xentripay.com`, and release v8 rewrote its host to `merchant.test.xentripay.com`. That host is the merchant dashboard, so every customer landed on `/auth/login`. The rewrite was a wrong guess and is removed.

What is still **not** known (ask XentriPAY, do not guess): before the rewrite, the link on `xentripay.com` opened a checkout page that said "Failed to load checkout session" with an amount of 0. Possible causes, none confirmed: the session belongs to a different XentriPAY environment than the page that tried to load it; the key is for a different environment than `XENTRIPAY_ENV`; or the checkout page needs something extra.

## Logs (Supabase, Edge Functions, `xentripay` and `xentripay-webhook`)
Every call writes one safe line. No keys, no customer data, no ids, no query strings.
- `xentripay call action=... env=... api=<host> key=set|missing`: the function was reached.
- `xentripay session api=<host> http=<code> created=<bool>`: XentriPAY answered the session request. `http=401` means the key is not valid on that host.
- `xentripay checkout link host=<host> path=<path with ids as :id> ok=<bool> reason=...`: what XentriPAY gave us.
- `xentripay-webhook call ...`, `... refused: bad signature`, `... verdict <PAID|REJECTED|PENDING>`.

If there is no `xentripay call` line when someone taps "Kwishyura", the request did not reach the function. The browser console then shows `[xentripay] call failed: ...`.

## Protections
- The amount comes from the server. Currency is `RWF`. A reported amount below the price, or a currency other than RWF, never marks a payment `PAID`.
- A second `checkout_create` from the same user within 15 seconds is refused (`duplicate_request`).
- A payment already `PAID` is never changed again, and a profile that has nothing to pay is refused (`nothing_to_pay`).
- The status endpoint returns no amount, so for checkout payments XentriPAY's `SUCCESS` plus our own server-side price is what confirms a payment.

## Questions for XentriPAY support
1. For merchant 381 and merchant 285, which dashboard host and which API host belong to the sandbox, and which to production? The sandbox API returns checkout links on `xentripay.com`.
2. What is the exact host and path of the customer checkout page for a session created in the sandbox? Why does it say "Failed to load checkout session"?
3. Which reference do the `CHECKOUT_*` webhooks carry (session id, `refid` or `customerRef`)? The status endpoint needs a `refid`; is there an endpoint to read a checkout session by its id?
4. Is the fee included in the amount for checkout sessions?

## First test (sandbox, after deploying)
1. Pay the smallest fee once.
2. Read the logs above and write down `host=` and `path=` of the checkout link.
3. Complete or cancel the payment. Check the `payments` row and the webhook log line.

## Deploying (manual, not done by Git)
1. Deploy `xentripay` and `xentripay-webhook` (the webhook folder has its own copy of `logic.mjs`).
2. Delete the retired functions `pay`, `pesapal-ipn`, `flw-webhook`, `pesapal-selftest` in the Supabase dashboard. If they still exist they only answer `410 Gone`.
3. Check the secrets above.

## Tests
`node tests/xentripay.logic.test.mjs` and `node tests/payments.only-xentripay.test.mjs`. No network.
