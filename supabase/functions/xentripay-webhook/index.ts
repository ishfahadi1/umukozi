import { createClient } from 'npm:@supabase/supabase-js@2';
import { decide, refsOf, statusRefOf, signatureOk } from './logic.mjs';

// XentriPAY notifies us here. The URL is plain (no secret in it). Two checks, in order:
//  1. the HMAC signature on the raw body, using the webhook secret XentriPAY returns when the webhook is created.
//     No secret configured = refuse everything.
//  2. the status is re-checked with XentriPAY using our own key before anything is marked PAID.
const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const XP_KEY = Deno.env.get('XENTRIPAY_API_KEY') || '';
const XP_BASE = Deno.env.get('XENTRIPAY_ENV') === 'live' ? 'https://xentripay.com' : 'https://merchant.test.xentripay.com';
const HOOK_SECRET = Deno.env.get('XENTRIPAY_WEBHOOK_SECRET') || '';
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  console.log('xentripay-webhook call', 'secret=' + (HOOK_SECRET ? 'set' : 'missing'));
  if (!HOOK_SECRET) return new Response('not_configured', { status: 401 });

  const raw = await req.text();
  if (!(await signatureOk(raw, HOOK_SECRET, req.headers.get('x-xentripay-signature') || ''))) {
    console.error('xentripay-webhook refused: bad signature');
    return new Response('bad_signature', { status: 401 });
  }

  let body: any = null;
  try { body = JSON.parse(raw); } catch { return new Response('bad_json', { status: 200 }); }
  const refs = refsOf(body);
  if (!refs.length || !XP_KEY) return new Response('ignored', { status: 200 });

  // Our customerRef is stored in provider_ref; XentriPAY's refid or session id is stored in provider_refid.
  let p: any = null;
  const byRef = await admin.from('payments').select('id, status, amount, provider_ref').eq('provider', 'xentripay').in('provider_ref', refs).maybeSingle();
  p = byRef.data;
  if (!p) {
    const byRefid = await admin.from('payments').select('id, status, amount, provider_ref').eq('provider', 'xentripay').in('provider_refid', refs).maybeSingle();
    p = byRefid.data;
  }
  if (!p) { console.log('xentripay-webhook: no payment for reference'); return new Response('unknown_reference', { status: 200 }); }
  if (p.status === 'PAID' || p.status === 'REJECTED') return new Response('settled', { status: 200 });

  const statusRef = statusRefOf(body) || String(p.provider_ref);
  const r = await fetch(XP_BASE + '/api/collections/status/' + encodeURIComponent(statusRef), {
    headers: { 'X-XENTRIPAY-KEY': XP_KEY, Accept: 'application/json' },
  });
  const st: any = await r.json().catch(() => null);
  if (r.status >= 300 || !st) return new Response('provider_unavailable', { status: 503 });

  const verdict = decide(
    st.status ?? st.data?.status,
    st.amount ?? st.data?.amount ?? body.data?.amount ?? null,
    Number(p.amount),
    st.currency ?? st.data?.currency ?? body.data?.currency ?? null,
  );
  console.log('xentripay-webhook verdict', verdict);
  if (verdict === 'PAID') {
    await admin.from('payments').update({ status: 'PAID', confirmed_at: new Date().toISOString() })
      .eq('id', p.id).neq('status', 'PAID');
  } else if (verdict === 'REJECTED') {
    await admin.from('payments').update({ status: 'REJECTED' }).eq('id', p.id).eq('status', 'PENDING');
  }
  return new Response('checked', { status: 200 });
});
