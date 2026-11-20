// Fiuto — Edge Function "notifica"
// Chiamata dai Database Webhooks (INSERT su segnalazioni e messaggi) e invia le notifiche push.
//
// Secrets richiesti (supabase secrets set ...):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (es. mailto:tu@email.it)
//   APP_URL        (es. https://fiuto.netlify.app/)
//   WEBHOOK_SECRET (stringa a caso, la stessa messa nell'header del webhook)
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sono già disponibili.

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT')!, Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!);
const APP = Deno.env.get('APP_URL') ?? '/';

type Sub = { endpoint: string; p256dh: string; auth: string; user_id: string };
type Msg = { title: string; body: string; url: string; tag?: string };

const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const t = (x: number) => x * Math.PI / 180, R = 6371;
  const h = Math.sin(t(b.lat - a.lat) / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(t(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

async function send(subs: Sub[], msg: Msg) {
  const seen = new Set<string>();
  await Promise.all(subs.filter(s => !seen.has(s.endpoint) && seen.add(s.endpoint)).map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: 6 * 3600 });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from('push_iscrizioni').delete().eq('endpoint', s.endpoint); // iscrizione scaduta
      else console.error('push', code, (e as Error).message);
    }
  }));
}
const subsOf = async (userIds: string[]) =>
  userIds.length ? ((await db.from('push_iscrizioni').select('endpoint,p256dh,auth,user_id').in('user_id', userIds)).data ?? []) as Sub[] : [];

Deno.serve(async req => {
  if (req.headers.get('x-webhook-secret') !== Deno.env.get('WEBHOOK_SECRET')) return new Response('forbidden', { status: 403 });
  const { type, table, record: r } = await req.json();
  if (type !== 'INSERT' || !r) return new Response('ignored');

  if (table === 'segnalazioni') {
    const animale = r.specie === 'gatto' ? 'Gatto' : 'Cane';
    const what = r.tipo === 'perso' ? `🔴 ${animale} smarrito vicino a te` : `🟢 ${animale} ${r.al_sicuro ? 'trovato' : 'avvistato'} vicino a te`;
    const body = [r.nome, r.razza, (r.colori ?? []).join(', '), r.descrizione].filter(Boolean).join(' · ').slice(0, 140);
    const url = `${APP}#s-${r.id}`;

    // 1) proprietari di segnalazioni opposte compatibili → "possibile match"
    const { data: opposte } = await db.from('segnalazioni')
      .select('id,owner_id,lat,lng,quando,tipo,microchip_hash')
      .eq('stato', 'attivo').eq('specie', r.specie).neq('tipo', r.tipo).neq('owner_id', r.owner_id)
      .gte('lat', r.lat - 0.15).lte('lat', r.lat + 0.15).gte('lng', r.lng - 0.2).lte('lng', r.lng + 0.2);
    const maxKm = r.specie === 'gatto' ? 4 : 12;
    const matchOwners = new Set<string>();
    for (const o of opposte ?? []) {
      const chip = r.microchip_hash && o.microchip_hash;
      if (chip ? r.microchip_hash === o.microchip_hash : km(r, o) <= maxKm) matchOwners.add(o.owner_id);
    }
    const matchSubs = await subsOf([...matchOwners]);
    await send(matchSubs, { title: '🎯 Possibile match per la tua segnalazione!', body: `${what.slice(2)}. ${body}`, url, tag: 'match-' + r.id });

    // 2) iscritti in zona (esclusi autore e chi ha già ricevuto il match)
    const { data: vicini } = await db.rpc('iscritti_vicini', { p_lat: r.lat, p_lng: r.lng, p_specie: r.specie, p_escludi: r.owner_id });
    const gia = new Set(matchSubs.map(s => s.endpoint));
    await send(((vicini ?? []) as Sub[]).filter(s => !gia.has(s.endpoint)), { title: what, body, url, tag: 'seg-' + r.id });
  }

  if (table === 'messaggi') {
    const { data: c } = await db.from('conversazioni').select('id,owner_id,altro_id,seg_info').eq('id', r.conversazione_id).single();
    if (c) {
      const dest = c.owner_id === r.autore_id ? c.altro_id : c.owner_id;
      const { data: blocco } = await db.from('blocchi').select('blocker_id').eq('blocker_id', dest).eq('blocked_id', r.autore_id).maybeSingle();
      if (!blocco) await send(await subsOf([dest]), {
        title: `💬 ${c.seg_info?.titolo ?? 'Nuovo messaggio'}`,
        body: String(r.testo).slice(0, 120),
        url: `${APP}#chat-${c.id}`,
        tag: 'chat-' + c.id
      });
    }
  }
  return new Response('ok');
});
