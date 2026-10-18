import { createClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const d9 = (p: unknown) => String(p ?? '').replace(/\D/g, '').slice(-9);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user || u.user.is_anonymous) return json({ error: 'unauthorized' }, 401);
  const uid = u.user.id;
  let b: any;
  try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const { data: prof } = await admin.from('profiles').select('id, referral_code, pay_status, suspended').eq('id', uid).maybeSingle();
  if (!prof) return json({ error: 'no_profile' }, 404);

  if (b.action === 'withdraw') {
    if (prof.suspended || prof.pay_status !== 'PAID') return json({ error: 'not_allowed' }, 403);
    const provider = b.provider;
    if (!['mtn', 'airtel'].includes(provider)) return json({ error: 'bad_provider' }, 400);
    const digits = d9(b.phone);
    const px = digits.slice(0, 2);
    const ok = provider === 'mtn' ? ['78', '79'].includes(px) : ['72', '73'].includes(px);
    if (digits.length !== 9 || !ok) return json({ error: 'phone_provider_mismatch' }, 400);
    const { data, error } = await admin.rpc('request_payout', { p_uid: uid, p_provider: provider, p_phone: '0' + digits });
    if (error) return json({ error: /below_minimum/.test(error.message) ? 'below_minimum' : 'failed' }, 400);
    return json({ ok: true, amount: Number(data) });
  }

  // summary
  const [{ data: st }, { data: earn }, { data: outs }, { count: direct }] = await Promise.all([
    admin.from('settings').select('ref_l1, ref_l2, min_payout').eq('id', true).single(),
    admin.from('referral_earnings').select('amount, level, created_at').eq('earner_id', uid).order('created_at', { ascending: false }),
    admin.from('payout_requests').select('amount, status, created_at').eq('profile_id', uid).order('created_at', { ascending: false }),
    admin.from('profiles').select('id', { count: 'exact', head: true }).eq('referred_by', uid),
  ]);
  const earned = (earn || []).reduce((s, x) => s + Number(x.amount), 0);
  const used = (outs || []).filter((x) => x.status !== 'REJECTED').reduce((s, x) => s + Number(x.amount), 0);
  const paidOut = (outs || []).filter((x) => x.status === 'PAID').reduce((s, x) => s + Number(x.amount), 0);
  return json({
    code: prof.referral_code,
    l1: Number(st?.ref_l1) || 100, l2: Number(st?.ref_l2) || 50, min_payout: Number(st?.min_payout) || 1000,
    direct: direct || 0, earned, balance: earned - used, paid_out: paidOut,
    pending_payout: (outs || []).filter((x) => x.status === 'PENDING').reduce((s, x) => s + Number(x.amount), 0),
    history: (earn || []).slice(0, 15),
  });
});
