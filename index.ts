import { createClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FLW_KEY = Deno.env.get('FLW_SECRET_KEY') || '';
// MOMO_MODE=live -> real Flutterwave Rwanda mobile money charge. Anything else -> SIMULATION (testing only).
const LIVE = Deno.env.get('MOMO_MODE') === 'live';
// Where Flutterwave sends the customer back after the hosted checkout page.
const APP_URL = Deno.env.get('APP_URL') || 'https://umukozi.ishfadi.com';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const d9 = (p: unknown) => String(p ?? '').replace(/\D/g, '').slice(-9);

async function flwVerify(txRef: string): Promise<any | null> {
  const r = await fetch('https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=' + encodeURIComponent(txRef), {
    headers: { Authorization: 'Bearer ' + FLW_KEY },
  });
  const d = await r.json().catch(() => null);
  return d && d.data ? d.data : null;
}

async function settle(paymentId: string, txRef: string, expected: number): Promise<'PAID' | 'REJECTED' | 'PENDING'> {
  const t = await flwVerify(txRef);
  if (!t) return 'PENDING';
  if (t.status === 'successful' && t.currency === 'RWF' && t.tx_ref === txRef && Number(t.amount) >= expected) {
    const { error } = await admin.from('payments')
      .update({ status: 'PAID', confirmed_at: new Date().toISOString(), provider_ref: txRef })
      .eq('id', paymentId).neq('status', 'PAID');
    if (error) throw error;
    return 'PAID';
  }
  if (t.status === 'failed') {
    await admin.from('payments').update({ status: 'REJECTED' }).eq('id', paymentId).eq('status', 'PENDING');
    return 'REJECTED';
  }
  return 'PENDING';
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

  if (b.action === 'check') {
    const { data: p } = await admin.from('payments').select('id, profile_id, status, provider_ref, amount').eq('id', String(b.payment_id || '')).maybeSingle();
    if (!p || p.profile_id !== uid) return json({ error: 'not_found' }, 404);
    if (p.status === 'PAID') return json({ status: 'PAID', payment_id: p.id });
    if (p.status === 'REJECTED') return json({ status: 'FAILED', payment_id: p.id });
    if (!LIVE || !FLW_KEY) return json({ status: 'PENDING', payment_id: p.id });
    const st = await settle(p.id, p.provider_ref, Number(p.amount));
    return json({ status: st === 'PAID' ? 'PAID' : st === 'REJECTED' ? 'FAILED' : 'PENDING', payment_id: p.id });
  }

  // Quote: tells the app the exact amount before the user taps "Kwishyura".
  const { data: prof } = await admin.from('profiles').select('*').eq('id', uid).maybeSingle();
  if (!prof) return json({ error: 'no_profile' }, 404);
  if (prof.suspended) return json({ error: 'suspended' }, 403);

  const { data: st } = await admin.from('settings').select('fee_worker,fee_employer,boost_prices').eq('id', true).single();
  let signupFee = 0;
  if (prof.role === 'worker') {
    const { data: cat } = await admin.from('categories').select('fee').eq('name', prof.category).maybeSingle();
    signupFee = Number(cat?.fee) || Number(st?.fee_worker) || 500;
  } else {
    signupFee = Number(st?.fee_employer) || 500;
  }

  const isBoost = b.action === 'boost' || (b.action === 'hosted' && b.boost === true);
  let purpose: 'activation' | 'reactivation' | 'boost' | null;
  let amount = signupFee;
  let boostDays: number | null = null;

  if (isBoost) {
    if (prof.pay_status !== 'PAID' || prof.status !== 'AVAILABLE') return json({ error: 'boost_not_allowed' }, 400);
    const prices = (st?.boost_prices || {}) as Record<string, number>;
    const days = String(Number(b.days));
    if (!(days in prices)) return json({ error: 'bad_boost_plan' }, 400);
    boostDays = Number(days);
    amount = Number(prices[days]);
    purpose = 'boost';
  } else {
    purpose = prof.pay_status !== 'PAID' ? 'activation' : prof.status === 'HIRED' ? 'reactivation' : null;
    if (!purpose) return json({ error: 'nothing_to_pay' }, 400);
  }
  if (b.action === 'quote') return json({ amount, purpose });

  // Hosted checkout: Flutterwave page with card and Rwanda mobile money (MTN, Airtel).
  if (b.action === 'hosted') {
    const digits = d9(prof.phone);
    if (digits.length !== 9) return json({ error: 'bad_phone' }, 400);
    const payId = crypto.randomUUID();
    const txRef = 'UMK-' + payId;
    const { data: pay, error: pe } = await admin.from('payments')
      .insert({ id: payId, profile_id: uid, provider: 'flutterwave', phone: '0' + digits, amount, purpose, boost_days: boostDays, status: 'PENDING', provider_ref: txRef })
      .select().single();
    if (pe || !pay) return json({ error: 'payment_failed' }, 500);

    if (!LIVE) {
      const { error: ae } = await admin.from('payments')
        .update({ status: 'PAID', confirmed_at: new Date().toISOString(), provider_ref: 'SIM-' + crypto.randomUUID() })
        .eq('id', pay.id);
      if (ae) return json({ error: 'payment_failed' }, 500);
      return json({ status: 'PAID', simulated: true, payment_id: pay.id, amount });
    }
    if (!FLW_KEY) return json({ error: 'not_configured' }, 500);

    const r = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + FLW_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tx_ref: txRef,
        amount,
        currency: 'RWF',
        redirect_url: APP_URL + '/?pay=' + pay.id,
        payment_options: 'card, mobilemoneyrwanda',
        customer: { email: u.user.email, phonenumber: '250' + digits, name: prof.name || 'Umukozi user' },
        customizations: { title: 'UMUKOZI', description: purpose === 'boost' ? 'Boost' : 'Kwemeza konti' },
      }),
    });
    const cd = await r.json().catch(() => ({}));
    if (!r.ok || cd.status !== 'success' || !cd.data?.link) {
      await admin.from('payments').update({ status: 'REJECTED' }).eq('id', pay.id);
      return json({ status: 'FAILED', payment_id: pay.id, error: cd.message || 'hosted_failed' }, 200);
    }
    return json({ status: 'REDIRECT', link: cd.data.link, payment_id: pay.id, amount });
  }

  const provider = b.provider;
  if (!['mtn', 'airtel'].includes(provider)) return json({ error: 'bad_provider' }, 400);
  const digits = d9(b.phone);
  const px = digits.slice(0, 2);
  const okPrefix = provider === 'mtn' ? ['78', '79'].includes(px) : ['72', '73'].includes(px);
  if (digits.length !== 9 || !okPrefix) return json({ error: 'phone_provider_mismatch' }, 400);
  if (LIVE && !FLW_KEY) return json({ error: 'not_configured' }, 500);

  const payId = crypto.randomUUID();
  const txRef = 'UMK-' + payId;
  const { data: pay, error: pe } = await admin.from('payments')
    .insert({ id: payId, profile_id: uid, provider, phone: '0' + digits, amount, purpose, boost_days: boostDays, status: 'PENDING', provider_ref: txRef })
    .select().single();
  if (pe || !pay) return json({ error: 'payment_failed' }, 500);

  if (!LIVE) {
    const { error: ae } = await admin.from('payments')
      .update({ status: 'PAID', confirmed_at: new Date().toISOString(), provider_ref: 'SIM-' + crypto.randomUUID() })
      .eq('id', pay.id);
    if (ae) return json({ error: 'payment_failed' }, 500);
    return json({ status: 'PAID', simulated: true, payment_id: pay.id, amount });
  }

  const r = await fetch('https://api.flutterwave.com/v3/charges?type=mobile_money_rwanda', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + FLW_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tx_ref: txRef, amount, currency: 'RWF', email: u.user.email,
      phone_number: '250' + digits, fullname: prof.name || 'Umukozi user',
    }),
  });
  const cd = await r.json().catch(() => ({}));
  if (!r.ok || cd.status !== 'success') {
    await admin.from('payments').update({ status: 'REJECTED' }).eq('id', pay.id);
    return json({ status: 'FAILED', payment_id: pay.id, error: cd.message || 'charge_failed' }, 200);
  }
  return json({ status: 'PENDING', payment_id: pay.id, amount });
});
