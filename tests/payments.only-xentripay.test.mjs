// Guards "XentriPAY is the only payment provider". Run: node tests/payments.only-xentripay.test.mjs
// Reads the repository files only. No network.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skip = new Set(['.git', 'node_modules', 'migrations', 'tests', 'docs', 'assets']);
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    if (skip.has(n)) continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(html|js|mjs|ts|json|toml|webmanifest)$/.test(n)) files.push(p);
  }
})(root);
const read = (f) => readFileSync(f, 'utf8');

// 1. no other provider anywhere in shipped code (old migrations and docs are history and are excluded)
const other = /pesapal|flutterwave|\bflw\b|stripe|paypal|mpesa|m-pesa|rwandapay|\bdpo\b|momo_mode/i;
for (const f of files) assert.ok(!other.test(read(f)), 'other payment provider mentioned in ' + f.replace(root, ''));

// 2. the retired payment functions are gone, and only xentripay functions handle payments
for (const gone of ['pay', 'pesapal-ipn', 'flw-webhook', 'pesapal-selftest']) {
  assert.ok(!existsSync(join(root, 'supabase/functions', gone)), 'function folder still in repo: ' + gone);
}
assert.ok(existsSync(join(root, 'supabase/functions/xentripay/index.ts')));
assert.ok(existsSync(join(root, 'supabase/functions/xentripay-webhook/index.ts')));

// 3. the app only calls xentripay for payments, and has no host rewrite
const html = read(join(root, 'index.html'));
const calls = new Set([...html.matchAll(/fnCall\('([a-z-]+)'/g)].map((m) => m[1]));
for (const c of calls) assert.ok(['account', 'xentripay', 'referral', 'ai-chat', 'log-error', 'admin', 'totp'].includes(c), 'unexpected function call: ' + c);
assert.ok(calls.has('xentripay'));
assert.equal(calls.has('pay'), false);

// 4. one startXpCheckout only (a duplicate silently overrides the first one)
assert.equal((html.match(/async function startXpCheckout\(/g) || []).length, 1, 'startXpCheckout defined more than once');

// 5. the server never rewrites the checkout host and always inspects the link
const fn = read(join(root, 'supabase/functions/xentripay/index.ts'));
assert.ok(!/fixCheckoutUrl|XENTRIPAY_CHECKOUT_HOST|c\.host\s*=/.test(fn), 'checkout host rewrite is back');
assert.ok(fn.includes('inspectCheckoutUrl(body.checkoutUrl)'), 'checkout link is not inspected');
assert.ok(fn.includes("customerFinalUrl: returnBase(b)"), 'return url missing');
assert.ok(/currency: 'RWF'/.test(fn));
assert.ok(fn.includes('duplicate_request'));

// 6. the front end checks the link before redirecting, with the same rules as the server
const m = html.match(/function xpSafeUrl\(u\)\{[^\r\n]*\}/);
assert.ok(m, 'xpSafeUrl missing');
const xpSafeUrl = new Function(m[0] + '; return xpSafeUrl;')();
assert.equal(xpSafeUrl('https://xentripay.com/checkout/cs_1234567890abcdef12'), 'https://xentripay.com/checkout/cs_1234567890abcdef12');
assert.equal(xpSafeUrl('https://merchant.test.xentripay.com/auth/login'), null, 'merchant login must never be a redirect target');
assert.equal(xpSafeUrl('https://xentripay.com/dashboard'), null);
assert.equal(xpSafeUrl('http://xentripay.com/checkout/x'), null);
assert.equal(xpSafeUrl('https://xentripay.com.evil.example/c'), null);
assert.equal(xpSafeUrl('javascript:alert(1)'), null);
assert.equal(xpSafeUrl(undefined), null);
assert.ok(/location\.href=go\b/.test(html) && !/location\.href=res\.checkoutUrl/.test(html), 'redirect must use the checked link');

// 7. the webhook refuses everything without a signature secret
const hook = read(join(root, 'supabase/functions/xentripay-webhook/index.ts'));
assert.ok(/if \(!HOOK_SECRET\) return new Response\('not_configured', \{ status: 401 \}\)/.test(hook));
assert.ok(hook.includes('signatureOk('));

// 8. the two copies of logic.mjs stay identical
assert.equal(read(join(root, 'supabase/functions/xentripay/logic.mjs')), read(join(root, 'supabase/functions/xentripay-webhook/logic.mjs')), 'logic.mjs copies differ');

// 9. both functions read the same environment switch
assert.ok(/XENTRIPAY_ENV'\) === 'live'/.test(fn) && /XENTRIPAY_ENV'\) === 'live'/.test(hook));

console.log('only-XentriPAY tests: all passed (' + files.length + ' files scanned)');
