import { createClient } from 'npm:@supabase/supabase-js@2';

// UMUKOZI AI assistant. It answers the signed-in user's questions about the app and never changes data.
const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const MODEL = 'claude-haiku-5-5';
const DAILY_LIMIT = 40;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

type Msg = { role: 'user' | 'assistant'; content: string };

function buildSystem(prof: any, cats: any[], st: any): string {
  const boosts = Object.entries((st?.boost_prices || {}) as Record<string, number>)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([d, p]) => `iminsi ${d} = ${p} RWF`)
    .join(', ');
  const fees = (cats || []).map((c: any) => `${c.name} ${c.fee} RWF`).join(', ');
  return [
    "Uri AI ya UMUKOZI, app ihuza abakozi n'abakoresha mu Rwanda. Ukorera ISHFADI Projects.",
    'Subiza mu rurimi umukoresha yandikamo (Ikinyarwanda cyangwa Icyongereza), mu magambo make kandi asobanutse.',
    '',
    'Ibyo uzi kuri app:',
    '- Konti nshya itangira ari NEW: ntigaragara ku isoko kugeza yishyuye kwiyandikisha.',
    `- Ibiciro byo kwiyandikisha: ${fees}; abakoresha ${st?.fee_employer} RWF.`,
    `- Boost (kugaragara cyane): ${boosts}.`,
    `- Referral: uwagusabye abona ${st?.ref_l1} RWF igihe wishyuye; uwamusabye we abona ${st?.ref_l2} RWF.`,
    `- Kubikuza bisaba byibura ${st?.min_payout} RWF.`,
    '- Konti ikora (AVAILABLE) igaragara ku isoko. "Nabonye umukozi/akazi" bivanaho konti ku isoko (HIRED). "Subira gushaka" bisaba kwishyura bundi bushya.',
    '- Kwishyura bikorerwa kuri page ya Pesapal: uhitamo MTN MoMo, Airtel Money cyangwa ikarita. Uburyo bugaragara bushingiye ku buryo bwemewe kuri konti ya UMUKOZI.',
    '',
    `Umukoresha: izina ${prof.name}, uruhare ${prof.role}, status ${prof.status}, kwishyura ${prof.pay_status}.`,
    '',
    'Amategeko:',
    '- Ntugasezerane amafaranga cyangwa ibintu sisitemu itemeza.',
    "- Ntugatange amakuru y'abandi bakoresha.",
    "- Ntuzigere usaba PIN, password cyangwa code ya Authenticator, kandi ntuzibatange.",
    "- Ku kibazo cy'amafaranga yatakaye, refund cyangwa payment itarangiye, bwira umukoresha ko agomba kwandikira ubuyobozi bwa UMUKOZI, kandi ko bizasuzumwa.",
    "- Niba utazi igisubizo neza, bivuge utyo.",
  ].join('\n');
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
  const message = String(b.message || '').trim().slice(0, 1500);
  if (!message) return json({ error: 'empty' }, 400);

  const { data: prof } = await admin.from('profiles').select('name, role, status, pay_status').eq('id', uid).maybeSingle();
  if (!prof) return json({ error: 'no_profile' }, 404);

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await admin.from('ai_logs').select('id', { count: 'exact', head: true })
    .eq('profile_id', uid).eq('role', 'user').gte('created_at', since);
  if ((count || 0) >= DAILY_LIMIT) return json({ error: 'daily_limit' }, 429);

  if (!ANTHROPIC_KEY) return json({ error: 'ai_not_configured' }, 503);

  const [{ data: st }, { data: cats }, { data: hist }] = await Promise.all([
    admin.from('settings').select('fee_employer,boost_prices,ref_l1,ref_l2,min_payout').eq('id', true).maybeSingle(),
    admin.from('categories').select('name, fee').order('name'),
    admin.from('ai_logs').select('role, content').eq('profile_id', uid).order('created_at', { ascending: false }).limit(12),
  ]);

  // Oldest first, and merged so that roles alternate the way the API expects.
  const msgs: Msg[] = [];
  for (const h of (hist || []).slice().reverse() as any[]) {
    if (!h.content) continue;
    const role: 'user' | 'assistant' = h.role === 'assistant' ? 'assistant' : 'user';
    if (!msgs.length && role !== 'user') continue;
    const prev = msgs[msgs.length - 1];
    if (prev && prev.role === role) prev.content += '\n' + h.content;
    else msgs.push({ role, content: String(h.content) });
  }
  const prev = msgs[msgs.length - 1];
  if (prev && prev.role === 'user') prev.content += '\n' + message;
  else msgs.push({ role: 'user', content: message });

  await admin.from('ai_logs').insert({ profile_id: uid, role: 'user', content: message });

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system: buildSystem(prof, cats || [], st), messages: msgs }),
  });
  const d: any = await r.json().catch(() => null);
  const reply = d && Array.isArray(d.content)
    ? d.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim()
    : '';
  if (!r.ok || !reply) {
    await admin.from('ai_logs').insert({ profile_id: uid, role: 'assistant', content: '', error: String(d?.error?.message || r.status) });
    return json({ error: 'ai_error' }, 502);
  }
  await admin.from('ai_logs').insert({ profile_id: uid, role: 'assistant', content: reply.slice(0, 4000) });
  return json({ reply });
});
