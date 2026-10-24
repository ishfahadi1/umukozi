// Pure helpers for the XentriPAY integration. No network, no secrets. Unit-tested in tests/.
// Facts come from the XentriPAY API Documentation v2.0 and Webhooks Integration Guide v1.0.

// Map whatever the provider says to one of our three words.
export function mapStatus(raw) {
  const s = String(raw || '').toUpperCase();
  if (s === 'SUCCESS' || s === 'SUCCESSFUL' || s === 'COMPLETED') return 'SUCCESS';
  if (s === 'FAILED' || s === 'FAILURE' || s === 'CANCELLED' || s === 'CANCELED') return 'FAILED';
  return 'PENDING';
}

// Decide what to do with a payment.
// The status endpoint is authenticated with our key and returns no amount, so SUCCESS is enough.
// If a response does report an amount or currency, it must match what we asked for.
export function decide(providerStatus, providerAmount, expectedAmount, currency) {
  const st = mapStatus(providerStatus);
  if (st === 'FAILED') return 'REJECTED';
  if (st !== 'SUCCESS') return 'PENDING';
  if (currency && String(currency).toUpperCase() !== 'RWF') return 'PENDING';
  if (providerAmount !== undefined && providerAmount !== null && Number(providerAmount) < Number(expectedAmount)) return 'PENDING';
  return 'PAID';
}

// The docs say success is a NUMBER (1 or 0), and retcode 0 means the request was accepted.
export function isAccepted(body, http) {
  return http < 300 && !!body && Number(body.success) === 1 && Number(Number(body.retcode)) === 0
    && typeof body.refid === 'string' && body.refid.length > 0;
}

// Phone formats: cnumber is local 10 digits, msisdn is international. Input here is the 9 digits after 0 / 250.
export function validNineDigits(d) { return /^7\d{8}$/.test(String(d || '')); }
export function cnumber(nineDigits) { return '0' + nineDigits; }
export function msisdn(nineDigits) { return '250' + nineDigits; }

// Boost price from the settings table, or null if the plan does not exist.
export function boostAmount(prices, days) {
  const k = String(Number(days));
  if (!prices || !(k in prices)) return null;
  const v = Number(prices[k]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Constant-time comparison (used for the URL token and the signature).
export function tokenOk(given, expected) {
  if (!expected || !given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// Every reference a webhook body might carry, de-duplicated, so we can find our payment.
export function refsOf(body) {
  if (!body || typeof body !== 'object') return [];
  const d = body.data && typeof body.data === 'object' ? body.data : {};
  const raw = [body.refid, body.refId, body.reference, body.customerRef, d.refid, d.reference, d.customerRef, body.transaction && body.transaction.refid];
  const out = [];
  for (const x of raw) {
    if (typeof x === 'string' && x.trim() && !out.includes(x.trim())) out.push(x.trim());
  }
  return out;
}

// X-Xentripay-Signature is "sha256=" + HMAC-SHA256(secret, raw body bytes), hex.
async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  let hex = '';
  for (const b of sig) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export async function signatureOk(rawBody, secret, header) {
  if (!secret || !header) return false;
  return tokenOk(String(header).trim(), 'sha256=' + (await hmacHex(secret, rawBody)));
}
