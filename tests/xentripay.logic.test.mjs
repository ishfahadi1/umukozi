// Unit tests for the XentriPAY helpers. Run with: node tests/xentripay.logic.test.mjs
// These use no network and no real provider. They check our rules, not XentriPAY's API.
import assert from 'node:assert/strict';
import * as L from '../supabase/functions/xentripay/logic.mjs';

// status mapping
assert.equal(L.mapStatus('SUCCESS'), 'SUCCESS');
assert.equal(L.mapStatus('success'), 'SUCCESS');
assert.equal(L.mapStatus('FAILED'), 'FAILED');
assert.equal(L.mapStatus('PENDING'), 'PENDING');
assert.equal(L.mapStatus(undefined), 'PENDING');
assert.equal(L.mapStatus('SOMETHING_NEW'), 'PENDING');

// a payment is PAID only with a provider success AND a covering amount in RWF
assert.equal(L.decide('SUCCESS', 500, 500, 'RWF'), 'PAID');
assert.equal(L.decide('SUCCESS', 600, 500, 'RWF'), 'PAID');
assert.equal(L.decide('SUCCESS', 400, 500, 'RWF'), 'PENDING', 'short amount must not pay');
assert.equal(L.decide('SUCCESS', undefined, 500, 'RWF'), 'PENDING', 'no amount reported must not pay');
assert.equal(L.decide('SUCCESS', 500, 500, 'USD'), 'PENDING', 'non-RWF must not pay');
assert.equal(L.decide('PENDING', 500, 500, 'RWF'), 'PENDING');
assert.equal(L.decide('FAILED', 500, 500, 'RWF'), 'REJECTED');

// phone formats
assert.equal(L.validNineDigits('780371519'), true);
assert.equal(L.validNineDigits('080371519'), false);
assert.equal(L.validNineDigits('78037151'), false);
assert.equal(L.cnumber('780371519'), '0780371519');
assert.equal(L.msisdn('780371519'), '250780371519');

// boost plans
assert.equal(L.boostAmount({ '2': 300, '7': 500, '30': 1000 }, 7), 500);
assert.equal(L.boostAmount({ '2': 300, '7': 500, '30': 1000 }, 3), null, 'unknown plan rejected');
assert.equal(L.boostAmount(null, 7), null);

// webhook token
assert.equal(L.tokenOk('abc123', 'abc123'), true);
assert.equal(L.tokenOk('abc124', 'abc123'), false);
assert.equal(L.tokenOk('', 'abc123'), false);
assert.equal(L.tokenOk('abc', ''), false, 'no configured token means nothing passes');

// reference lookup in webhook bodies
assert.equal(L.pickRef({ refid: 'X1' }), 'X1');
assert.equal(L.pickRef({ data: { refid: 'X2' } }), 'X2');
assert.equal(L.pickRef({ foo: 1 }), null);
assert.equal(L.pickRef(null), null);

console.log('xentripay logic tests: all passed');
