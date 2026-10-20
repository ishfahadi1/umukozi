import { createClient } from 'npm:@supabase/supabase-js@2';

// The owner's AI analyst. Only admins can call it. It reads a summary of the app and answers.
// It never changes data and keeps no record of the conversation: the admin page holds the chat in memory.
const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const MODEL = 'claude-haiku-5-5';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const sb = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

type Msg = { role: 'user' | 'assistant'; content: string };
const H = 3600 * 1000;

const SYSTEM = [
  'You are the operations analyst (AI manager) of ISHFADI Projects for the UMUKOZI app. You are talking only with the owner, who is the admin.',
  'Answer in the language the owner writes in (Kinyarwanda, English, French, or any other).',
  'Use ONLY the data in the snapshot below. Give numbers, and say how they changed compared with the previous 24 hours or the previous 7 days.',
  'Start with what needs attention most urgently. Then say what is healthy, what went up, and what went down. Finish with concrete next steps.',
  'If something is not in the snapshot (for example Netlify or Supabase credit balances), say so. Never invent numbers.',
  'You cannot change data or settings. If the owner asks for a change, say exactly what would change and that it must be done in the admin with the owner confirming it. Never say a change was done.',
  'Never ask for or reveal PINs, setup codes, authenticator codes, API keys or other secrets.',
  'Talk about users only in totals. Never name a user or give a phone number or email.',
].join('\n');

function count<T>(rows: T[], pred: (r: T) => boolean): number {
  let n = 0;
  for (const r of rows) if (pred(r)) n++;
  return n;
}
const sum = (rows: any[], f: (r: any) => number) => rows.reduce((s, r) => s + f(r), 0);
const iso = (t: number) => new Date(t).toISOString();

async function snapshot(): Promise<any> {
  const now = Date.now();
  const t24 = now - 24 * H, t48 = now - 48 * H, t7d = now - 7 * 24 * H, t30m = now - 30 * 60 * 1000;

  const [{ data: profiles }, { data: payments }, { data: errors }, { data: refs }, { data: payouts }, { data: settings }, { data: cats }] = await Promise.all([
    sb.from('profiles').select('status,pay_status,role,created_at').limit(10000),
    sb.from('payments').select('status,provider,purpose,amount,payment_method,created_at,confirmed_at').gte('created_at', iso(t7d)).limit(10000),
    sb.from('app_errors').select('message,path,source,created_at').gte('created_at', iso(t48)).limit(5000),
    sb.from('referral_earnings').select('amount,level,created_at').gte('created_at', iso(t7d)).limit(10000),
    sb.from('payout_requests').select('status,amount,created_at').gte('created_at', iso(t7d)).limit(5000),
    sb.from('settings').select('fee_worker,fee_employer,boost_prices,ref_l1,ref_l2,min_payout,pesapal_ipn_env').eq('id', true).maybeSingle(),
    sb.from('categories').select('name,fee').order('name'),
  ]);

  const P = profiles || [], PAY = payments || [], E = errors || [], R = refs || [], PO = payouts || [];
  const inWin = (r: any, from: number, to: number) => { const t = new Date(r.created_at).getTime(); return t >= from && t < to; };

  // Sign-ups
  const signups = {
    total: P.length,
    by_status: { NEW: count(P, (p: any) => p.status === 'NEW'), AVAILABLE: count(P, (p: any) => p.status === 'AVAILABLE'), HIRED: count(P, (p: any) => p.status === 'HIRED') },
    paid: count(P, (p: any) => p.pay_status === 'PAID'),
    last_24h: count(P, (p: any) => inWin(p, t24, now)),
    previous_24h: count(P, (p: any) => inWin(p, t48, t24)),
    last_7d: count(P, (p: any) => inWin(p, t7d, now)),
  };

  // Payments
  const paidNow = PAY.filter((p: any) => p.status === 'PAID' && inWin(p, t24, now));
  const paidPrev = PAY.filter((p: any) => p.status === 'PAID' && inWin(p, t48, t24));
  const payBlock = (rows: any[]) => ({ count: rows.length, amount_rwf: sum(rows, (r: any) => Number(r.amount) || 0) });
  const byKey = (rows: any[], k: (r: any) => string) => {
    const out: Record<string, number> = {};
    for (const r of rows) { const key = k(r) || 'unknown'; out[key] = (out[key] || 0) + 1; }
    return out;
  };
  const payments_block = {
    last_24h: {
      paid: payBlock(paidNow),
      failed_or_rejected: count(PAY, (p: any) => (p.status === 'REJECTED' || p.status === 'FAILED') && inWin(p, t24, now)),
      pending_now: count(PAY, (p: any) => p.status === 'PENDING' && inWin(p, t7d, now)),
      by_status: byKey(PAY.filter((p: any) => inWin(p, t24, now)), (p: any) => p.status),
      by_provider_paid: byKey(paidNow, (p: any) => p.provider),
      by_method_paid: byKey(paidNow, (p: any) => p.payment_method),
      by_purpose_paid: byKey(paidNow, (p: any) => p.purpose),
    },
    previous_24h: { paid: payBlock(paidPrev) },
    last_7d: { paid: payBlock(PAY.filter((p: any) => p.status === 'PAID')), pending_older_than_30_min: count(PAY, (p: any) => p.status === 'PENDING' && new Date(p.created_at).getTime() < t30m) },
  };

  // Money going out and referrals
  const money_block = {
    referral_rewards_last_24h_rwf: sum(R.filter((r: any) => inWin(r, t24, now)), (r: any) => Number(r.amount) || 0),
    referral_rewards_last_7d_rwf: sum(R, (r: any) => Number(r.amount) || 0),
    payout_requests_last_7d: { count: PO.length, amount_rwf: sum(PO, (r: any) => Number(r.amount) || 0), by_status: byKey(PO, (r: any) => r.status) },
  };

  // App errors: how many, and which messages are new today
  const errNow = E.filter((e: any) => inWin(e, t24, now));
  const errPrev = E.filter((e: any) => inWin(e, t48, t24));
  const prevMsgs = new Set(errPrev.map((e: any) => String(e.message).slice(0, 120)));
  const topNow: Record<string, number> = {};
  for (const e of errNow) { const k = String(e.message).slice(0, 120); topNow[k] = (topNow[k] || 0) + 1; }
  const top = Object.entries(topNow).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([message, n]) => ({ message, count: n, new_since_yesterday: !prevMsgs.has(message) }));
  const errors_block = { last_24h: errNow.length, previous_24h: errPrev.length, top_last_24h: top };

  // Last 7 days, day by day (paid payments and sign-ups)
  const days: any[] = [];
  for (let d = 6; d >= 0; d--) {
    const from = now - (d + 1) * 24 * H, to = now - d * 24 * H;
    days.push({
      day: new Date(to - 1).toISOString().slice(0, 10),
      signups: count(P, (p: any) => inWin(p, from, to)),
      paid_count: count(PAY, (p: any) => p.status === 'PAID' && inWin(p, from, to)),
      paid_rwf: sum(PAY.filter((p: any) => p.status === 'PAID' && inWin(p, from, to)), (p: any) => Number(p.amount) || 0),
      errors: count(E, (e: any) => inWin(e, from, to)),
    });
  }

  return {
    generated_at: iso(now),
    not_included: ['Netlify credit balance', 'Supabase usage and credits', 'server logs'],
    signups,
    payments: payments_block,
    money: money_block,
    errors: errors_block,
    last_7_days: days,
    settings_now: { fee_employer: settings?.fee_employer, fee_worker: settings?.fee_worker, boost_prices: settings?.boost_prices, ref_l1: settings?.ref_l1, ref_l2: settings?.ref_l2, min_payout: settings?.min_payout, pesapal_mode: settings?.pesapal_ipn_env },
    category_fees: (cats || []).map((c: any) => ({ name: c.name, fee: c.fee })),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: u, error: ue } = await sb.auth.getUser(token);
  if (ue || !u?.user) return json({ error: 'unauthorized' }, 401);
  const { data: isAdmin } = await sb.from('admins').select('id').eq('id', u.user.id).maybeSingle();
  if (!isAdmin) return json({ error: 'forbidden' }, 403);

  if (!ANTHROPIC_KEY) return json({ error: 'ai_not_configured' }, 503);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const incoming: Msg[] = Array.isArray(b.messages) ? b.messages : [];
  const clean: Msg[] = [];
  for (const m of incoming.slice(-20)) {
    const role: 'user' | 'assistant' = m && m.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m?.content || '').slice(0, 4000).trim();
    if (!content) continue;
    const prev = clean[clean.length - 1];
    if (prev && prev.role === role) prev.content += '\n' + content;
    else clean.push({ role, content });
  }
  while (clean.length && clean[0].role !== 'user') clean.shift();
  if (!clean.length || clean[clean.length - 1].role !== 'user') return json({ error: 'empty' }, 400);

  const snap = await snapshot();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: SYSTEM + '\n\nSNAPSHOT (JSON):\n' + JSON.stringify(snap),
      messages: clean,
    }),
  });
  const d: any = await r.json().catch(() => null);
  const reply = d && Array.isArray(d.content)
    ? d.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim()
    : '';
  if (!r.ok || !reply) return json({ error: 'ai_error' }, 502);
  return json({ reply, generated_at: snap.generated_at });
});
