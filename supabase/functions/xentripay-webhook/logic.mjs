// Pure helpers for the XentriPAY integration. No network, no secrets: these are unit-tested in tests/.

// Map whatever the provider says to one of our three words.
export function mapStatus(raw) {
  const s = String(raw || '').toUpperCase();
  if (s === 'SUCCESS' || s === 'SUCCESSFUL' || s === 'COMPLETED') return 'SUCCESS';
  if (s === 'FAILED' || s === 'FAILURE' || s === 'CANCELLED' || s === 'CANCELED') return 'FAILED';
  return 'PENDING';
}

// Decide what to do with a payment. A success is only believed when the provider also reports
// an amount that covers what we expect, and the currency is RWF. Otherwise it stays PENDING.
export function decide(providerStatus, providerAmount, expectedAmount, currency) {
  const st = mapStatus(providerStatus);
  if (st === 'FAILED') return 'REJECTED';
  if (st !== 'SUCCESS') return 'PENDING';
  if (providerAmount === undefined || providerAmount === null) return 'PENDING';
  if (currency && String(currency).toUpperCase() !== 'RWF') return 'PENDING';
  if (Number(providerAmount) < Number(expectedAmount)) return 'PENDING';
  return 'PAID';
}

// Phone formats XentriPAY documents: local 10 digits for cnumber, international for msisdn.
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

// Constant-time comparison for the webhook token.
export function tokenOk(given, expected) {
  if (!expected || !given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// Find XentriPAY's reference in a webhook body, whatever the wrapper looks like.
export function pickRef(body) {
  if (!body || typeof body !== 'object') return null;
  const cands = [body.refid, body.refId, body.reference, body.data && body.data.refid, body.transaction && body.transaction.refid];
  const found = cands.find((x) => typeof x === 'string' && x.trim().length > 0);
  return found ? found.trim() : null;
}
