// Unit tests for the XentriPAY helpers. Run with: node tests/xentripay.logic.test.mjs
// No network, no real provider. These check our rules against the documented formats.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as L from '../supabase/functions/xentripay/logic.mjs';

// status mapping
assert.equal(L.mapStatus('SUCCESS'), 'SUCCESS');
assert.equal(L.mapStatus('SUCCESSFUL'), 'SUCCESS', 'webhook payloads use SUCCESSFUL');
assert.equal(L.mapStatus('FAILED'), 'FAILED');
assert.equal(L.mapStatus('PENDING'), 'PENDING');
assert.equal(L.mapStatus('SOMETHING_NEW'), 'PENDING');

// decisions: the status endpoint has no amount, so SUCCESS alone is enough
assert.equal(L.decide('SUCCESS', undefined, 500, 'RWF'), 'PAID', 'status endpoint returns no amount');
assert.equal(L.decide('SUCCESS', null, 500, 'RWF'), 'PAID');
assert.equal(L.decide('SUCCESS', 500, 500, 'RWF'), 'PAID');
assert.equal(L.decide('SUCCESS', 400, 500, 'RWF'), 'PENDING', 'a reported short amount must not pay');
assert.equal(L.decide('SUCCESS', undefined, 500, 'USD'), 'PENDING', 'a reported non-RWF currency must not pay');
assert.equal(L.decide('PENDING', undefined, 500, 'RWF'), 'PENDING');
assert.equal(L.decide('FAILED', undefined, 500, 'RWF'), 'REJECTED');

// accepted initiation: success is numeric 1, retcode 0, refid present
assert.equal(L.isAccepted({ success: 1, retcode: 0, refid: 'RefE1108D491A1C' }, 200), true);
assert.equal(L.isAccepted({ success: 0, retcode: 606, refid: 'x' }, 200), false);
assert.equal(L.isAccepted({ success: 1, retcode: 607, refid: 'x' }, 200), false);
assert.equal(L.isAccepted({ success: 1, retcode: 0 }, 200), false, 'no refid means no collection to track');
assert.equal(L.isAccepted({ success: 1, retcode: 0, refid: 'x' }, 400), false);
assert.equal(L.isAccepted(null, 200), false);

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

// URL token
assert.equal(L.tokenOk('abc123', 'abc123'), true);
assert.equal(L.tokenOk('abc124', 'abc123'), false);
assert.equal(L.tokenOk('', 'abc123'), false);
assert.equal(L.tokenOk('abc', ''), false, 'no configured token means nothing passes');

// references found in webhook bodies
assert.deepEqual(L.refsOf({ refid: 'X1' }), ['X1']);
assert.deepEqual(L.refsOf({ data: { reference: 'COL-1', customerRef: 'P9' } }), ['COL-1', 'P9']);
assert.deepEqual(L.refsOf({ foo: 1 }), []);
assert.deepEqual(L.refsOf(null), []);

// HMAC signature over the RAW body, exactly as documented
const secret = 'test-secret-123';
const raw = '{"event":"COLLECTION_SUCCESSFUL","data":{"id":9871,"amount":50000}}';
const good = 'sha256=' + createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
assert.equal(await L.signatureOk(raw, secret, good), true);
assert.equal(await L.signatureOk(raw + ' ', secret, good), false, 'any change to the body breaks the signature');
assert.equal(await L.signatureOk(raw, 'wrong-secret', good), false);
assert.equal(await L.signatureOk(raw, secret, ''), false, 'missing header refused');
assert.equal(await L.signatureOk(raw, '', good), false, 'no configured secret refused');
assert.equal(await L.signatureOk(raw, secret, good.replace('sha256=', '')), false, 'prefix is required');

assert.deepEqual(L.refsOf({ sessionId: 'cs_1' }), ['cs_1']);
assert.equal(L.statusRefOf({ data: { refid: 'RefA' } }), 'RefA');
assert.equal(L.statusRefOf({ refid: 'RefB' }), 'RefB');
assert.equal(L.statusRefOf({ foo: 1 }), null);

console.log('xentripay logic tests: all passed');
