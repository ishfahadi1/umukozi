import { createClient } from 'npm:@supabase/supabase-js@2';

// Pesapal calls this URL with no user login, after a payment changes.
// We never trust the query string: we ask Pesapal for the real status, and only then mark the payment PAID.
const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PESAPAL_KEY = Deno.env.get('PESAPAL_CONSUMER_KEY') || '';
const PESAPAL_SECRET = Deno.env.get('PESAPAL_CONSUMER_SECRET') || '';
const PESAPAL_BASE = Deno.env.get('PESAPAL_ENV') === 'live' ? 'https://pay.pesapal.com/v3/api' : 'https://cybqa.pesapal.com/pesapalv3/api';
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

// Pesapal expects this JSON back. A non-200 answer makes Pesapal retry later.
const ack = (trackingId: string, ref: string, notif: string, status = 200) =>
  new Response(JSON.stringify({ orderNotificationType: notif, orderTrackingId: trackingId, orderMerchantReference: ref, status: String(status) }), {
    status, headers: { 'Content-Type': 'application/json' },
  });

async function pesapalToken(): Promise<string | null> {
  const r = await fetch(PESAPAL_BASE + '/Auth/RequestToken', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ consumer_key: PESAPAL_KEY, consumer_secret: PESAPAL_SECRET }),
  });
  const d = await r.json().catch(() => null);
  return d && d.token ? d.token : null;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const trackingId = url.searchParams.get('OrderTrackingId') || '';
  const ref = url.searchParams.get('OrderMerchantReference') || '';
  const notif = url.searchParams.get('OrderNotificationType') || 'IPNCHANGE';
  if (!trackingId || !ref || !PESAPAL_KEY || !PESAPAL_SECRET) return ack(trackingId, ref, notif, 400);

  const { data: p } = await admin.from('payments').select('id, amount, status').eq('id', ref).maybeSingle();
  if (!p) return ack(trackingId, ref, notif, 200); // unknown payment: acknowledge, nothing to do
  if (p.status === 'PAID') return ack(trackingId, ref, notif, 200);

  const tk = await pesapalToken();
  if (!tk) return ack(trackingId, ref, notif, 500);
  const r = await fetch(PESAPAL_BASE + '/Transactions/GetTransactionStatus?orderTrackingId=' + encodeURIComponent(trackingId), {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + tk },
  });
  const t = await r.json().catch(() => null);
  if (!t) return ack(trackingId, ref, notif, 500);

  const desc = String(t.payment_status_description || '').toLowerCase();
  if (desc === 'completed' && t.currency === 'RWF' && Number(t.amount) >= Number(p.amount)) {
    const { error } = await admin.from('payments')
      .update({ status: 'PAID', confirmed_at: new Date().toISOString(), provider_ref: trackingId })
      .eq('id', p.id).neq('status', 'PAID');
    if (error) return ack(trackingId, ref, notif, 500);
  } else if (desc === 'failed' || desc === 'invalid' || desc === 'reversed') {
    await admin.from('payments').update({ status: 'REJECTED' }).eq('id', p.id).eq('status', 'PENDING');
  }
  return ack(trackingId, ref, notif, 200);
});
