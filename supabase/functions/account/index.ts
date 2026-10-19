import { createClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const PROV: Record<string, string> = {};
[
  ['Umujyi wa Kigali', ['Gasabo', 'Kicukiro', 'Nyarugenge']],
  ['Intara y’Amajyaruguru', ['Burera', 'Gakenke', 'Gicumbi', 'Musanze', 'Rulindo']],
  ['Intara y’Amajyepfo', ['Gisagara', 'Huye', 'Kamonyi', 'Muhanga', 'Nyamagabe', 'Nyanza', 'Nyaruguru', 'Ruhango']],
  ['Intara y’Iburasirazuba', ['Bugesera', 'Gatsibo', 'Kayonza', 'Kirehe', 'Ngoma', 'Nyagatare', 'Rwamagana']],
  ['Intara y’Iburengerazuba', ['Karongi', 'Ngororero', 'Nyabihu', 'Nyamasheke', 'Rubavu', 'Rusizi', 'Rutsiro']],
].forEach(([p, ds]) => (ds as string[]).forEach((d) => (PROV[d] = p as string)));

const d9 = (p: unknown) => String(p ?? '').replace(/\D/g, '').slice(-9);
const emailOf = (d: string) => `250${d}@umukozi.app`;
const PHONE_RE = /^7[2389]\d{7}$/;
const photoOk = (u: string) => u === '' || /^https:\/\/res\.cloudinary\.com\//.test(u);

async function userFrom(req: Request) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user || data.user.is_anonymous) return null;
  return data.user;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  if (b.action === 'signup') {
    const p = b.profile || {};
    const pw = String(b.password || '');
    const digits = d9(p.phone);
    if (!PHONE_RE.test(digits)) return json({ error: 'bad_phone' }, 400);
    if (pw.length < 6 || pw.length > 72) return json({ error: 'bad_password' }, 400);
    if (!['worker', 'employer'].includes(p.role)) return json({ error: 'bad_role' }, 400);
    const name = String(p.name || '').trim();
    if (name.length < 2 || name.length > 80) return json({ error: 'bad_name' }, 400);
    const contactEmail = String(p.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail) || contactEmail.length > 120) return json({ error: 'bad_email' }, 400);
    const province = PROV[p.district];
    if (!province) return json({ error: 'bad_district' }, 400);
    const { data: cat } = await admin.from('categories').select('name').eq('name', p.category).maybeSingle();
    if (!cat) return json({ error: 'bad_category' }, 400);
    const photo = String(p.photo_url || '');
    if (!photoOk(photo)) return json({ error: 'bad_photo' }, 400);

    let referredBy: string | null = null;
    const refCode = String(b.ref || '').trim().toUpperCase().slice(0, 12);
    if (refCode) {
      const { data: rp } = await admin.from('profiles').select('id').eq('referral_code', refCode).maybeSingle();
      if (rp) referredBy = rp.id;   // unknown code is ignored silently
    }

    const { data: dup } = await admin.from('profiles').select('id').eq('phone_digits', digits).maybeSingle();
    if (dup) return json({ error: 'phone_exists' }, 409);

    const email = emailOf(digits);
    const { data: cu, error: ce } = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
    if (ce || !cu?.user) {
      if (/already|exists|registered/i.test(ce?.message || '')) return json({ error: 'phone_exists' }, 409);
      return json({ error: 'create_failed' }, 500);
    }
    const worker = p.role === 'worker';
    const row = {
      id: cu.user.id, role: p.role, name, phone: String(p.phone).trim().slice(0, 20), province, district: p.district,
      category: p.category, salary: Math.min(100000000, Math.max(0, Number(p.salary) || 0)),
      live: p.live === 'Abamo' ? 'Abamo' : 'Ataha',
      experience: worker ? String(p.experience || '').slice(0, 40) : null,
      description: worker ? null : String(p.description || '').slice(0, 500),
      photo_url: photo,
      referred_by: referredBy,
      contact_email: contactEmail,
    };
    const { data: prof, error: pe } = await admin.from('profiles').insert(row).select().single();
    if (pe) {
      await admin.auth.admin.deleteUser(cu.user.id);
      return json({ error: /duplicate|unique/i.test(pe.message) ? 'phone_exists' : 'profile_failed' }, /duplicate|unique/i.test(pe.message) ? 409 : 500);
    }
    const anon = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: s, error: se } = await anon.auth.signInWithPassword({ email, password: pw });
    if (se || !s?.session) return json({ error: 'signin_failed' }, 500);
    return json({ session: s.session, profile: prof });
  }

  if (b.action === 'update_phone') {
    const user = await userFrom(req);
    if (!user) return json({ error: 'unauthorized' }, 401);
    const digits = d9(b.phone);
    if (!PHONE_RE.test(digits)) return json({ error: 'bad_phone' }, 400);
    const { data: dup } = await admin.from('profiles').select('id').eq('phone_digits', digits).neq('id', user.id).maybeSingle();
    if (dup) return json({ error: 'phone_exists' }, 409);
    const oldEmail = user.email!;
    const { error: ue } = await admin.auth.admin.updateUserById(user.id, { email: emailOf(digits), email_confirm: true });
    if (ue) return json({ error: /already|exists|registered/i.test(ue.message) ? 'phone_exists' : 'update_failed' }, /already|exists|registered/i.test(ue.message) ? 409 : 500);
    const { data: prof, error: pe } = await admin.from('profiles').update({ phone: String(b.phone).trim().slice(0, 20) }).eq('id', user.id).select().single();
    if (pe) {
      await admin.auth.admin.updateUserById(user.id, { email: oldEmail, email_confirm: true });
      return json({ error: 'update_failed' }, 500);
    }
    return json({ profile: prof });
  }

  return json({ error: 'unknown_action' }, 400);
});
