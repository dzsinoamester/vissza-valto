/**
 * Vissza! – send-push Edge Function
 *
 * Mit csinál: az admin által küldött értesítést kiküldi minden feliratkozott
 * böngészőnek web push csatornán. Csak admin hívhatja (a JWT-t ellenőrzi,
 * majd a public.is_admin() függvényt kérdezi).
 *
 * Szükséges secret-ek (Supabase → Edge Functions → Secrets):
 *   VAPID_PUBLIC   – a publikus kulcs (ugyanaz, mint a js/config.js-ben)
 *   VAPID_PRIVATE  – a privát kulcs (SOHA nem kerül a kliensbe)
 *   VAPID_SUBJECT  – pl. mailto:dzsinokalla@gmail.com
 *
 * Telepítés (a projekt gyökerében):
 *   supabase functions deploy send-push --project-ref kukzlgfsabhgvnqvqfvc
 *
 * Előtte futtatni kell: data/supabase-push.sql
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const pub = Deno.env.get('VAPID_PUBLIC');
  const priv = Deno.env.get('VAPID_PRIVATE');
  const subject = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com';

  if (!url || !anon || !service) return json({ error: 'missing supabase env' }, 500);
  if (!pub || !priv) return json({ error: 'missing vapid secrets' }, 500);

  const auth = req.headers.get('Authorization') || '';
  if (!auth.toLowerCase().startsWith('bearer ')) return json({ error: 'unauthorized' }, 401);

  const asUser = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false }
  });

  const { data: userData, error: userErr } = await asUser.auth.getUser();
  if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

  const { data: adminFlag, error: adminErr } = await asUser.rpc('is_admin');
  if (adminErr || adminFlag !== true) return json({ error: 'forbidden' }, 403);

  let payload: { title?: string; body?: string; url?: string } = {};
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  const title = String(payload.title || '').trim();
  const body = String(payload.body || '').trim();
  if (!title || !body) return json({ error: 'title and body required' }, 400);

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: subs, error: subsErr } = await admin
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth');

  if (subsErr) return json({ error: subsErr.message }, 500);
  if (!subs || !subs.length) return json({ ok: true, sent: 0, removed: 0 });

  webpush.setVapidDetails(subject, pub, priv);

  let sent = 0;
  let removed = 0;
  const stale: string[] = [];

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body, url: './', tag: 'vissza-ann' }),
        { TTL: 60 * 60 * 24 }
      );
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) stale.push(s.endpoint);
    }
  }));

  if (stale.length) {
    const { error } = await admin.from('push_subscriptions').delete().in('endpoint', stale);
    if (!error) removed = stale.length;
  }

  return json({ ok: true, sent, removed });
});
