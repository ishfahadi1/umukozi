import { createClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';
const OWNER_EMAIL = 'official@ishfadi.com';
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
const ITER = 210000;
// Accept codes from 90 seconds before to 90 seconds after, so a phone clock that is a bit off still works.
const WINDOW = 3;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of clean) {
    const v = B32.indexOf(c);
    if (v === -1) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(bytes);
}

function randomBase32(byteCount: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(byteCount));
  let bits = '';
  for (const b of raw) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function totpAt(secretB32: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base32Decode(secretB32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(4, counter >>> 0);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const offset = sig[sig.length - 1] & 0x0f;
  const code = ((sig[offset] & 0x7f) << 24) | ((sig[offset + 1] & 0xff) << 16) | ((sig[offset + 2] & 0xff) << 8) | (sig[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

async function matchStep(secretB32: string, code: string): Promise<number> {
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let w = -WINDOW; w <= WINDOW; w++) {
    if ((await totpAt(secretB32, counter + w)) === code) return counter + w;
  }
  return -1;
}

async function totpMatches(secretB32: string, code: string): Promise<boolean> {
  const counter = Math.floor(Date.now() / 1000 / 30);
  let ok = false;
  for (let w = -WINDOW; w <= WINDOW; w++) {
    if ((await totpAt(secretB32, counter + w)) === code) ok = true;
  }
  return ok;
}

async function pbkdf2Hash(secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, key, 256));
  return 'pbkdf2_sha256$' + ITER + '$' + toB64(salt) + '$' + toB64(bits);
}

async function hashMatches(stored: string, secret: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  const salt = Uint8Array.from(atob(parts[2]), (c) => c.charCodeAt(0));
  const expected = Uint8Array.from(atob(parts[3]), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, expected.length * 8));
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
  return diff === 0;
}

function otpauthUri(secret: string): string {
  return 'otpauth://totp/' + encodeURIComponent('UMUKOZI Admin') + ':' + encodeURIComponent(OWNER_EMAIL) +
    '?secret=' + secret + '&issuer=UMUKOZI&algorithm=SHA1&digits=6&period=30';
}

async function ownerUserId(): Promise<string | null> {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error || !data) return null;
  const u = data.users.find((x) => (x.email || '').toLowerCase() === OWNER_EMAIL);
  return u ? u.id : null;
}

async function status(): Promise<{ setup: boolean; open: boolean }> {
  const { data: done } = await admin.from('admins').select('id').not('password_hash', 'is', null).limit(1);
  const complete = !!(done && done.length);
  const { data: boot } = await admin.from('admin_bootstrap').select('id').eq('id', 1).maybeSingle();
  return { setup: complete, open: !complete && !!boot };
}

async function setupCodeOk(code: string): Promise<boolean> {
  const { data } = await admin.from('admin_bootstrap').select('code_hash').eq('id', 1).maybeSingle();
  if (!data) return false;
  return await hashMatches(data.code_hash, code);
}

async function sessionFor(id: string): Promise<Response> {
  const { data: u, error: ue } = await admin.auth.admin.getUserById(id);
  if (ue || !u?.user?.email) return json({ error: 'account_error' }, 500);
  const { data: link, error: le } = await admin.auth.admin.generateLink({ type: 'magiclink', email: u.user.email });
  if (le || !link) return json({ error: 'link_failed' }, 500);
  const hashed = (link as any).properties?.hashed_token;
  if (!hashed) return json({ error: 'link_failed' }, 500);
  return json({ token_hash: hashed, email: u.user.email });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  if (b.action === 'status') return json(await status());

  if (b.action === 'setup_begin') {
    if ((await status()).setup) return json({ error: 'closed' }, 403);
    if (!(await setupCodeOk(String(b.setup_code || '')))) return json({ error: 'setup_code' }, 401);
    const owner = await ownerUserId();
    if (!owner) return json({ error: 'account_error' }, 500);
    // While setup is unfinished, keep the same secret, so the QR code stays the same on every retry.
    const { data: cur } = await admin.from('admins').select('totp_secret, password_hash').eq('id', owner).maybeSingle();
    const secret = cur && cur.totp_secret && !cur.password_hash ? cur.totp_secret : randomBase32(20);
    const { error } = await admin.from('admins').upsert(
      { id: owner, name: 'Boss', photo_url: '', notif_signups: true, notif_payments: true, notif_hired: true,
        totp_secret: secret, password_hash: null, failed_attempts: 0, locked_until: null },
      { onConflict: 'id' },
    );
    if (error) return json({ error: 'save_failed' }, 500);
    return json({ uri: otpauthUri(secret) });
  }

  if (b.action === 'setup_confirm') {
    if ((await status()).setup) return json({ error: 'closed' }, 403);
    if (!(await setupCodeOk(String(b.setup_code || '')))) return json({ error: 'setup_code' }, 401);
    const pin = String(b.password || '');
    const code = String(b.code || '').replace(/\D/g, '');
    if (!/^\d{4}$/.test(pin) || !/^\d{6}$/.test(code)) return json({ error: 'bad_input' }, 400);
    const { data: rows, error } = await admin.from('admins').select('id, totp_secret').limit(1);
    if (error) return json({ error: 'lookup_failed' }, 500);
    const row = rows && rows[0];
    if (!row || !row.totp_secret) return json({ error: 'invalid' }, 401);
    const step = await matchStep(row.totp_secret, code);
    if (step < 0) { console.log('setup_confirm: authenticator code did not match', new Date().toISOString()); return json({ error: 'code' }, 401); }
    const hash = await pbkdf2Hash(pin);
    const { data: claimed, error: ue } = await admin.from('admins')
      .update({ password_hash: hash, failed_attempts: 0, locked_until: null, last_step: step })
      .eq('id', row.id).lt('last_step', step).select('id');
    if (ue || !claimed || !claimed.length) return json({ error: 'save_failed' }, 500);
    await admin.from('admin_bootstrap').delete().eq('id', 1);
    return await sessionFor(row.id);
  }

  if (b.action === 'login') {
    const pin = String(b.password || '');
    const code = String(b.code || '').replace(/\D/g, '');
    if (!/^\d{4}$/.test(pin) || !/^\d{6}$/.test(code)) return json({ error: 'bad_input' }, 400);
    const { data: rows, error } = await admin
      .from('admins')
      .select('id, totp_secret, password_hash, failed_attempts, locked_until, last_step')
      .limit(1);
    if (error) return json({ error: 'lookup_failed' }, 500);
    const row = rows && rows[0];
    if (!row || !row.totp_secret || !row.password_hash) return json({ error: 'invalid' }, 401);
    if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) return json({ error: 'locked' }, 429);
    const pinOk = await hashMatches(row.password_hash, pin);
    const step = await matchStep(row.totp_secret, code);
    const codeOk = step >= 0 && step > Number(row.last_step ?? -1);
    if (!(pinOk && codeOk)) {
      const failed = (row.failed_attempts || 0) + 1;
      const lockUntil = failed >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
      await admin.from('admins').update({ failed_attempts: lockUntil ? 0 : failed, locked_until: lockUntil }).eq('id', row.id);
      const reason = !pinOk ? 'pin' : step < 0 ? 'code' : 'code_used';
      console.log('login refused:', reason, '| failed count now', failed, '| locking', !!lockUntil, '|', new Date().toISOString());
      return json({ error: reason }, 401);
    }
    // Claim the step: a code can be used once, even if two requests race with the same code.
    const { data: claimed, error: ce } = await admin.from('admins')
      .update({ failed_attempts: 0, locked_until: null, last_step: step })
      .eq('id', row.id).lt('last_step', step).select('id');
    if (ce || !claimed || !claimed.length) return json({ error: 'invalid' }, 401);
    return await sessionFor(row.id);
  }

  return json({ error: 'unknown_action' }, 400);
});
