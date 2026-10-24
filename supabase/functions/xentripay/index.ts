import { createClient } from 'npm:@supabase/supabase-js@2';
import { decide, cnumber, msisdn, validNineDigits, boostAmount } from './logic.mjs';

// XentriPAY mobile-money collections (MTN MoMo, Airtel Money). Used only when XENTRIPAY_API_KEY is set
// AND XENTRIPAY_MOMO is "on" (switch on only after XentriPAY confirms the methods for our merchant account).
// Card payments stay on Pesapal. Keys live only in Supabase secrets.
const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const XP_KEY = Deno.env.get('XENTRIPAY_API_KEY') || '';
const XP_BASE = Deno.env.get('XENTRIPAY_ENV') === 'live' ? 'https://xentripay.com' : 'https://merchant.test.xentripay.com';
const MOMO_ON = Deno.env.get('XENTRIPAY_MOMO') === 'on';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
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

// Ask XentriPAY for the real status of one collection. Returns the decision for our payment.
async function verdictFor(providerRef: string, expected: number): Promise<'PAID' | 'REJECTED' | 'PENDING'> {
  const { http, body } = await xp('/api/collections/status/' + encodeURIComponent(providerRef), { method: 'GET' });
  if (http >= 300 || !body) return 'PENDING';
  const raw = body.status ?? body.data?.status;
  const amt = body.amount ?? body.data?.amount;
  const cur = body.currency ?? body.data?.currency;
  return decide(raw, amt, expected, cur);
}

async function applyVerdict(paymentId: string, providerRef: string, verdict: 'PAID' | 'REJECTED' | 'PENDING') {
  if (verdict === 'PAID') {
    await admin.from('payments')
      .update({ status: 'PAID', confirmed_at: new Date().toISOString(), provider_ref: providerRef })
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

  // What the app may show. Tells nothing secret.
  if (b.action === 'options') return json({ configured: !!XP_KEY, momo: MOMO_ON && !!XP_KEY });

  if (b.action === 'status') {
    const { data: p } = await admin.from('payments').select('id, profile_id, status, provider, provider_ref, amount')
      .eq('id', String(b.payment_id || '')).maybeSingle();
    if (!p || p.profile_id !== uid || p.provider !== 'xentripay') return json({ error: 'not_found' }, 404);
    if (p.status === 'PAID') return json({ status: 'PAID', payment_id: p.id });
    if (p.status === 'REJECTED') return json({ status: 'FAILED', payment_id: p.id });
    if (!XP_KEY || !p.provider_ref) return json({ status: 'PENDING', payment_id: p.id });
    const v = await verdictFor(String(p.provider_ref), Number(p.amount));
    await applyVerdict(p.id, String(p.provider_ref), v);
    return json({ status: v === 'PAID' ? 'PAID' : v === 'REJECTED' ? 'FAILED' : 'PENDING', payment_id: p.id });
  }

  if (b.action === 'initiate') {
    if (!XP_KEY || !MOMO_ON) return json({ error: 'not_configured' }, 503);

    const { data: prof } = await admin.from('profiles').select('*').eq('id', uid).maybeSingle();
    if (!prof) return json({ error: 'no_profile' }, 404);
    if (prof.suspended) return json({ error: 'suspended' }, 403);
    if (!prof.contact_email) return json({ error: 'email_required' }, 400);
    const digits = d9(prof.phone);
    if (!validNineDigits(digits)) return json({ error: 'bad_phone' }, 400);

    // The amount is decided here on the server, never taken from the client.
    const { data: st } = await admin.from('settings').select('fee_worker,fee_employer,boost_prices').eq('id', true).single();
    let amount: number;
    let purpose: 'activation' | 'reactivation' | 'boost';
    let boostDays: number | null = null;
    if (b.purpose === 'boost') {
      if (prof.pay_status !== 'PAID' || prof.status !== 'AVAILABLE') return json({ error: 'boost_not_allowed' }, 400);
      boostDays = Number(b.days);
      const amt = boostAmount(st?.boost_prices, boostDays);
      if (amt === null) return json({ error: 'bad_boost_plan' }, 400);
      amount = amt;
      purpose = 'boost';
    } else {
      if (prof.pay_status !== 'PAID') purpose = 'activation';
      else if (prof.status === 'HIRED') purpose = 'reactivation';
      else return json({ error: 'nothing_to_pay' }, 400);
      if (prof.role === 'worker') {
        const { data: cat } = await admin.from('categories').select('fee').eq('name', prof.category).maybeSingle();
        amount = Number(cat?.fee) || Number(st?.fee_worker) || 500;
      } else {
        amount = Number(st?.fee_employer) || 500;
      }
    }
    if (!Number.isInteger(amount) || amount < 100) return json({ error: 'bad_amount' }, 400);

    // Persist the attempt before we call the provider.
    const payId = crypto.randomUUID();
    const { error: pe } = await admin.from('payments').insert({
      id: payId, profile_id: uid, provider: 'xentripay', phone: '0' + digits, amount, purpose,
      boost_days: boostDays, status: 'PENDING', provider_ref: payId,
    });
    if (pe) return json({ error: 'payment_failed' }, 500);

    const { http, body } = await xp('/api/collections/initiate', {
      method: 'POST',
      body: JSON.stringify({
        email: prof.contact_email,
        cname: String(prof.name || 'Umukozi user').trim(),
        amount,
        cnumber: cnumber(digits),
        msisdn: msisdn(digits),
        currency: 'RWF',
        pmethod: 'momo',
      }),
    });
    const accepted = http < 300 && body && body.success === true && body.refid;
    if (!accepted) {
      await admin.from('payments').update({ status: 'REJECTED' }).eq('id', payId);
      return json({ status: 'FAILED', payment_id: payId, error: 'provider_rejected', retcode: body?.retcode ?? null }, 200);
    }
    await admin.from('payments').update({ provider_ref: String(body.refid) }).eq('id', payId);
    return json({ status: 'PENDING', payment_id: payId, amount, instruction: 'approve_on_phone' });
  }

  return json({ error: 'unknown_action' }, 400);
});
