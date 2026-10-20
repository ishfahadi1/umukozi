import { createClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FLW_KEY = Deno.env.get('FLW_SECRET_KEY') || '';
const HASH = Deno.env.get('FLW_WEBHOOK_HASH') || '';
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

async function flwVerify(txRef: string): Promise<any | null> {
  const r = await fetch('https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=' + encodeURIComponent(txRef), {
    headers: { Authorization: 'Bearer ' + FLW_KEY },
  });
  const d = await r.json().catch(() => null);
  return d && d.data ? d.data : null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  // Flutterwave sends the secret hash you set in its dashboard in the verif-hash header.
  if (!HASH || req.headers.get('verif-hash') !== HASH) return new Response('unauthorized', { status: 401 });

  const ev = await req.json().catch(() => null);
  const txRef = ev && ev.data && ev.data.tx_ref;
  if (!txRef || ev.event !== 'charge.completed') return new Response('ignored', { status: 200 });

  const { data: p } = await admin.from('payments').select('id, amount, status').eq('provider_ref', txRef).maybeSingle();
  if (!p) return new Response('unknown_reference', { status: 200 });
  if (p.status === 'PAID') return new Response('already_paid', { status: 200 });

  // Re-check with Flutterwave; the webhook body alone is not trusted.
  const t = await flwVerify(txRef);
  if (t && t.status === 'successful' && t.currency === 'RWF' && t.tx_ref === txRef && Number(t.amount) >= Number(p.amount)) {
    await admin.from('payments')
      .update({ status: 'PAID', confirmed_at: new Date().toISOString() })
      .eq('id', p.id).neq('status', 'PAID');
    return new Response('paid', { status: 200 });
  }
  if (t && t.status === 'failed') {
    await admin.from('payments').update({ status: 'REJECTED' }).eq('id', p.id).eq('status', 'PENDING');
  }
  return new Response('checked', { status: 200 });
});
