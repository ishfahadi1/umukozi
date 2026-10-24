import { createClient } from 'npm:@supabase/supabase-js@2';
import { decide, pickRef, tokenOk } from './logic.mjs';

// XentriPAY notifies us here. The body is never trusted: we only take the reference from it,
// then ask XentriPAY for the real status using our own key. The URL carries a secret token,
// and if that token is not configured every request is refused.
const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const XP_KEY = Deno.env.get('XENTRIPAY_API_KEY') || '';
const XP_BASE = Deno.env.get('XENTRIPAY_ENV') === 'live' ? 'https://xentripay.com' : 'https://merchant.test.xentripay.com';
const HOOK_TOKEN = Deno.env.get('XENTRIPAY_WEBHOOK_TOKEN') || '';
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  const given = new URL(req.url).searchParams.get('token') || '';
  if (!tokenOk(given, HOOK_TOKEN)) return new Response('unauthorized', { status: 401 });

  const body = await req.json().catch(() => null);
  const ref = pickRef(body);
  if (!ref || !XP_KEY) return new Response('ignored', { status: 200 });

  const { data: p } = await admin.from('payments').select('id, status, amount, provider')
    .eq('provider_ref', ref).eq('provider', 'xentripay').maybeSingle();
  if (!p) return new Response('unknown_reference', { status: 200 });
  if (p.status === 'PAID' || p.status === 'REJECTED') return new Response('settled', { status: 200 });

  const { http, body: st } = await (async () => {
    const r = await fetch(XP_BASE + '/api/collections/status/' + encodeURIComponent(ref), {
      headers: { 'X-XENTRIPAY-KEY': XP_KEY, Accept: 'application/json' },
    });
    return { http: r.status, body: await r.json().catch(() => null) };
  })();
  if (http >= 300 || !st) return new Response('provider_unavailable', { status: 503 });

  const verdict = decide(st.status ?? st.data?.status, st.amount ?? st.data?.amount, Number(p.amount), st.currency ?? st.data?.currency);
  if (verdict === 'PAID') {
    await admin.from('payments').update({ status: 'PAID', confirmed_at: new Date().toISOString(), provider_ref: ref })
      .eq('id', p.id).neq('status', 'PAID');
  } else if (verdict === 'REJECTED') {
    await admin.from('payments').update({ status: 'REJECTED' }).eq('id', p.id).eq('status', 'PENDING');
  }
  return new Response('checked', { status: 200 });
});
