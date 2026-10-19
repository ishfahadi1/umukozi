import { createClient } from 'npm:@supabase/supabase-js@2';

// Errors the app reports about itself, so the AI manager can see what people run into.
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
const clip = (v: unknown, n: number): string => String(v ?? '').slice(0, n);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const message = clip(b.message, 500).trim();
  if (!message) return json({ error: 'empty' }, 400);

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: u } = await admin.auth.getUser(token);
  const uid = u?.user && !u.user.is_anonymous ? u.user.id : null;

  // Flood guard: at most 300 rows in any 10 minutes.
  const since = new Date(Date.now() - 10 * 60000).toISOString();
  const { count } = await admin.from('app_errors').select('id', { count: 'exact', head: true }).gte('created_at', since);
  if ((count || 0) > 300) return json({ ok: false, error: 'busy' }, 429);

  const { error } = await admin.from('app_errors').insert({
    profile_id: uid, source: clip(b.source, 20) || 'web', path: clip(b.path, 120), message, details: clip(b.details, 2000),
  });
  if (error) return json({ ok: false }, 500);
  return json({ ok: true });
});
