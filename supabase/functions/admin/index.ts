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
const sb = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const d9 = (p: unknown) => String(p ?? '').replace(/\D/g, '').slice(-9);
const emailOf = (d: string) => `250${d}@umukozi.app`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: u, error: ue } = await sb.auth.getUser(token);
  if (ue || !u?.user) return json({ error: 'unauthorized' }, 401);
  const { data: isAdmin } = await sb.from('admins').select('id').eq('id', u.user.id).maybeSingle();
  if (!isAdmin) return json({ error: 'forbidden' }, 403);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const id = String(b.user_id || '');
  if (!UUID.test(id)) return json({ error: 'bad_id' }, 400);

  if (b.action === 'delete_user') {
    if (id === u.user.id) return json({ error: 'cannot_delete_self' }, 400);
    const { data: target } = await sb.from('admins').select('id').eq('id', id).maybeSingle();
    if (target) return json({ error: 'cannot_delete_admin' }, 400);
    const { error } = await sb.auth.admin.deleteUser(id); // cascades to profiles / payments
    if (error) return json({ error: 'delete_failed' }, 500);
    return json({ ok: true });
  }

  if (b.action === 'update_phone') {
    const digits = d9(b.phone);
    if (!/^7[2389]\d{7}$/.test(digits)) return json({ error: 'bad_phone' }, 400);
    const { data: target } = await sb.from('profiles').select('id').eq('id', id).maybeSingle();
    if (!target) return json({ error: 'not_found' }, 404);
    const { data: dup } = await sb.from('profiles').select('id').eq('phone_digits', digits).neq('id', id).maybeSingle();
    if (dup) return json({ error: 'phone_exists' }, 409);
    const { data: cur } = await sb.auth.admin.getUserById(id);
    const oldEmail = cur?.user?.email;
    const { error: ee } = await sb.auth.admin.updateUserById(id, { email: emailOf(digits), email_confirm: true });
    if (ee) return json({ error: /already|exists|registered/i.test(ee.message) ? 'phone_exists' : 'update_failed' }, /already|exists|registered/i.test(ee.message) ? 409 : 500);
    const { error: pe } = await sb.from('profiles').update({ phone: String(b.phone).trim().slice(0, 20) }).eq('id', id);
    if (pe) {
      if (oldEmail) await sb.auth.admin.updateUserById(id, { email: oldEmail, email_confirm: true });
      return json({ error: 'update_failed' }, 500);
    }
    return json({ ok: true });
  }

  return json({ error: 'unknown_action' }, 400);
});
