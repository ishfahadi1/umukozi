import { createClient } from 'npm:@supabase/supabase-js@2';
import { decide, cnumber, msisdn, validNineDigits, boostAmount, isAccepted, inspectCheckoutUrl, inspectPayUrl } from './logic.mjs';

// XentriPAY, used for mobile money (MTN, Airtel) and cards, on XentriPAY's own checkout page.
// Only active when XENTRIPAY_API_KEY is set. "options" tells the app what is switched on:
//   One "Kwishyura" button: the customer picks MoMo or card on XentriPAY's page. Always on when the key is set.
//   action "initiate": MoMo prompt (MTN, Airtel) or card, in the app's own screen. Used by the app.
// Keys live only in Supabase secrets.
const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_URL = Deno.env.get('APP_URL') || 'https://umukozi.ishfadi.com';
const XP_KEY = Deno.env.get('XENTRIPAY_API_KEY') || '';
const XP_BASE = Deno.env.get('XENTRIPAY_ENV') === 'live' ? 'https://xentripay.com' : 'https://merchant.test.xentripay.com';
const XP_ENV = Deno.env.get('XENTRIPAY_ENV') === 'live' ? 'live' : 'test';
// XentriPAY is the only payment provider: the checkout is on whenever the API key is set.
const CHECKOUT_ON = true;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
// The customer returns to the site they paid from, but only if it is ours.
function returnBase(b: any): string {
  try {
    const o = new URL(String(b?.origin || ''));
    const ok = o.protocol === 'https:' && (o.origin === new URL(APP_URL).origin || o.hostname.endsWith('.ishfadi.com') || o.hostname === 'ishfadi.com' || o.hostname.endsWith('.netlify.app'));
    if (ok) return o.origin;
  } catch { /* fall through */ }
  return APP_URL;
}
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const d9 = (p: unknown) => String(p ?? '').replace(/\D/g, '').slice(-9);

async function xp(path: string, init: RequestInit = {}): Promise<{ http: number; body: any }> {
  const r = await fetch(XP_BASE + path, {
    ...init,
    headers: { 'X-XENTRIPAY-KEY': XP_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  const body = await r.json().catch(() => null);
  return { http: r.status, body };
}

// The amount is always decided here on the server, never taken from the client.
type Price = { error: string; code: number } | { prof: any; amount: number; purpose: 'activation' | 'reactivation' | 'boost'; boostDays: number | null };
async function priceFor(uid: string, b: any, needEmail = false): Promise<Price> {
  const { data: prof } = await admin.from('profiles').select('*').eq('id', uid).maybeSingle();
  if (!prof) return { error: 'no_profile', code: 404 };
  if (prof.suspended) return { error: 'suspended', code: 403 };
  if (needEmail && !prof.contact_email) return { error: 'email_required', code: 400 };
  const { data: st } = await admin.from('settings').select('fee_worker,fee_employer,boost_prices').eq('id', true).single();
  let amount: number;
  let purpose: 'activation' | 'reactivation' | 'boost';
  let boostDays: number | null = null;
  if (b.purpose === 'boost') {
    if (prof.pay_status !== 'PAID' || prof.status !== 'AVAILABLE') return { error: 'boost_not_allowed', code: 400 };
    boostDays = Number(b.days);
    const amt = boostAmount(st?.boost_prices, boostDays);
    if (amt === null) return { error: 'bad_boost_plan', code: 400 };
    amount = amt;
    purpose = 'boost';
  } else {
    if (prof.pay_status !== 'PAID') purpose = 'activation';
    else if (prof.status === 'HIRED') purpose = 'reactivation';
    else return { error: 'nothing_to_pay', code: 400 };
    if (prof.role === 'worker') {
      const { data: cat } = await admin.from('categories').select('fee').eq('name', prof.category).maybeSingle();
      amount = Number(cat?.fee) || Number(st?.fee_worker) || 500;
    } else {
      amount = Number(st?.fee_employer) || 500;
    }
  }
  if (!Number.isInteger(amount) || amount < 100) return { error: 'bad_amount', code: 400 };
  return { prof, amount, purpose, boostDays };
}

// Ask XentriPAY for the status of one collection, using our customerRef (the docs accept it).
async function verdictFor(customerRef: string, expected: number): Promise<'PAID' | 'REJECTED' | 'PENDING'> {
  const { http, body } = await xp('/api/collections/status/' + encodeURIComponent(customerRef), { method: 'GET' });
  if (http >= 300 || !body) return 'PENDING';
  return decide(
    body.status ?? body.data?.status,
    body.amount ?? body.data?.amount ?? null,
    expected,
    body.currency ?? body.data?.currency ?? null,
  );
}

async function applyVerdict(paymentId: string, verdict: 'PAID' | 'REJECTED' | 'PENDING') {
  if (verdict === 'PAID') {
    await admin.from('payments').update({ status: 'PAID', confirmed_at: new Date().toISOString() })
      .eq('id', paymentId).neq('status', 'PAID');
  } else if (verdict === 'REJECTED') {
    await admin.from('payments').update({ status: 'REJECTED' }).eq('id', paymentId).eq('status', 'PENDING');
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user || u.user.is_anonymous) return json({ error: 'unauthorized' }, 401);
  const uid = u.user.id;

  let b: any;
  try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  // One safe line per call, so an empty log means the function was not reached. No key, no user data.
  console.log('xentripay call', 'action=' + String(b?.action ?? ''), 'env=' + XP_ENV, 'api=' + new URL(XP_BASE).host, 'key=' + (XP_KEY ? 'set' : 'missing'));

  // What the app may show. Tells nothing secret.
  if (b.action === 'options') return json({ configured: !!XP_KEY, checkout: CHECKOUT_ON && !!XP_KEY, momo: !!XP_KEY, card: !!XP_KEY });

  if (b.action === 'status') {
    const { data: p } = await admin.from('payments').select('id, profile_id, status, provider, provider_ref, amount')
      .eq('id', String(b.payment_id || '')).maybeSingle();
    if (!p || p.profile_id !== uid || p.provider !== 'xentripay') return json({ error: 'not_found' }, 404);
    if (p.status === 'PAID') return json({ status: 'PAID', payment_id: p.id });
    if (p.status === 'REJECTED') return json({ status: 'FAILED', payment_id: p.id });
    if (!XP_KEY || !p.provider_ref) return json({ status: 'PENDING', payment_id: p.id });
    let v = await verdictFor(String(p.provider_ref), Number(p.amount));
    if (v === 'PENDING') {
      const { data: q } = await admin.from('payments').select('provider_refid').eq('id', p.id).maybeSingle();
      if (q?.provider_refid) v = await verdictFor(String(q.provider_refid), Number(p.amount));
    }
    await applyVerdict(p.id, v);
    return json({ status: v === 'PAID' ? 'PAID' : v === 'REJECTED' ? 'FAILED' : 'PENDING', payment_id: p.id });
  }

  // One button: create a checkout session and send the customer to XentriPAY's page, where they choose MoMo or card.
  if (b.action === 'checkout_create') {
    if (!XP_KEY || !CHECKOUT_ON) return json({ error: 'not_configured' }, 503);
    const pr = await priceFor(uid, b);
    if ('error' in pr) return json({ error: pr.error }, pr.code);
    const digits = d9(pr.prof.phone);
    if (!validNineDigits(digits)) return json({ error: 'bad_phone' }, 400);

    // A second request within a few seconds (double tap, retry) must not open a second checkout.
    const since = new Date(Date.now() - 15000).toISOString();
    const { data: recent } = await admin.from('payments').select('id').eq('profile_id', uid).eq('provider', 'xentripay')
      .eq('status', 'PENDING').gte('created_at', since).limit(1);
    if (recent && recent.length) return json({ error: 'duplicate_request' }, 429);

    const payId = crypto.randomUUID();
    const { error: pe } = await admin.from('payments').insert({
      id: payId, profile_id: uid, provider: 'xentripay', phone: '0' + digits, amount: pr.amount, purpose: pr.purpose,
      boost_days: pr.boostDays, status: 'PENDING', provider_ref: payId,
    });
    if (pe) return json({ error: 'payment_failed' }, 500);

    const { http, body } = await xp('/api/checkout/sessions', {
      method: 'POST',
      body: JSON.stringify({ amount: pr.amount, customerFinalUrl: returnBase(b) + '/?xp=' + payId, currency: 'RWF' }),
    });
    const created = http < 300 && !!body && typeof body.id === 'string' && typeof body.checkoutUrl === 'string';
    console.log('xentripay session', 'api=' + new URL(XP_BASE).host, 'http=' + http, 'created=' + created);
    if (!created) {
      await admin.from('payments').update({ status: 'REJECTED' }).eq('id', payId);
      const why = String(body?.message ?? body?.error ?? body?.reply ?? '').slice(0, 200);
      console.error('xentripay session refused', 'http=' + http, 'why=' + why);
      return json({ status: 'FAILED', payment_id: payId, error: 'provider_rejected', provider_http: http, provider_message: why }, 200);
    }
    await admin.from('payments').update({ provider_refid: String(body.id) }).eq('id', payId);

    // The link is used exactly as XentriPAY gave it. It is only refused if it cannot be a payment page.
    const link = inspectCheckoutUrl(body.checkoutUrl);
    console.log('xentripay checkout link', 'host=' + link.host, 'path=' + link.path, 'ok=' + link.ok, link.ok ? '' : 'reason=' + link.reason);
    if (!link.ok) {
      await admin.from('payments').update({ status: 'REJECTED' }).eq('id', payId);
      return json({ status: 'FAILED', payment_id: payId, error: 'invalid_checkout_url', reason: link.reason, link_host: link.host, link_path: link.path }, 200);
    }
    return json({ status: 'REDIRECT', checkoutUrl: link.url, payment_id: payId, amount: pr.amount });
  }

  // Direct payment in our own screen: MoMo prompt on the phone (MTN, Airtel) or card (redirect).
  // The fee comes out of the amount (chargesIncluded), so the customer pays exactly the price shown in the app.
  if (b.action === 'initiate') {
    if (!XP_KEY) return json({ error: 'not_configured' }, 503);
    const method = b.method === 'cc' ? 'cc' : 'momo';
    const pr = await priceFor(uid, b);
    if ('error' in pr) return json({ error: pr.error }, pr.code);
    const digits = method === 'momo' ? d9(b.phone || pr.prof.phone) : d9(pr.prof.phone);
    if (method === 'momo' && !validNineDigits(digits)) return json({ error: 'bad_phone' }, 400);

    const since = new Date(Date.now() - 15000).toISOString();
    const { data: recent } = await admin.from('payments').select('id').eq('profile_id', uid).eq('provider', 'xentripay')
      .eq('status', 'PENDING').gte('created_at', since).limit(1);
    if (recent && recent.length) return json({ error: 'duplicate_request' }, 429);

    // Our reference (customerRef) is saved before we call the provider, so every attempt is traceable.
    const payId = crypto.randomUUID();
    const { error: pe } = await admin.from('payments').insert({
      id: payId, profile_id: uid, provider: 'xentripay', phone: digits ? '0' + digits : null, amount: pr.amount, purpose: pr.purpose,
      boost_days: pr.boostDays, status: 'PENDING', provider_ref: payId,
    });
    if (pe) return json({ error: 'payment_failed' }, 500);

    const back = returnBase(b) + '/?xp=' + payId;
    const payload: Record<string, unknown> = {
      email: pr.prof.contact_email || (uid + '@umukozi.ishfadi.com'),
      cname: String(pr.prof.name || 'Umukozi user').trim(),
      amount: pr.amount,
      currency: 'RWF',
      pmethod: method,
      customerRef: payId,
      chargesIncluded: true,
      details: pr.purpose === 'boost' ? 'UMUKOZI boost' : 'UMUKOZI kwemeza konti',
    };
    if (method === 'momo') { payload.cnumber = cnumber(digits); payload.msisdn = msisdn(digits); }
    else { payload.redirecturl = back; payload.returl = back; if (digits) { payload.cnumber = cnumber(digits); payload.msisdn = msisdn(digits); } }

    const { http, body } = await xp('/api/collections/initiate', { method: 'POST', body: JSON.stringify(payload) });
    console.log('xentripay initiate', 'method=' + method, 'api=' + new URL(XP_BASE).host, 'http=' + http, 'retcode=' + String(body?.retcode ?? ''));
    if (!isAccepted(body, http)) {
      await admin.from('payments').update({ status: 'REJECTED' }).eq('id', payId);
      return json({ status: 'FAILED', payment_id: payId, error: 'provider_rejected', retcode: body?.retcode ?? null, provider_http: http }, 200);
    }
    await admin.from('payments').update({ provider_refid: String(body.refid) }).eq('id', payId);
    if (method === 'cc') {
      const link = inspectPayUrl(body.url);
      console.log('xentripay card link', 'host=' + link.host, 'path=' + link.path, 'ok=' + link.ok, link.ok ? '' : 'reason=' + link.reason);
      if (!link.ok) {
        await admin.from('payments').update({ status: 'REJECTED' }).eq('id', payId);
        return json({ status: 'FAILED', payment_id: payId, error: 'invalid_card_url', reason: link.reason }, 200);
      }
      return json({ status: 'REDIRECT', url: link.url, payment_id: payId, amount: pr.amount });
    }
    return json({ status: 'PENDING', payment_id: payId, amount: pr.amount, instruction: 'approve_on_phone' });
  }

  return json({ error: 'unknown_action' }, 400);
});
