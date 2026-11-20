// Fiuto — Edge Function "notifica"
// Chiamata dai Database Webhooks su `segnalazioni` (INSERT e UPDATE) e `messaggi` (INSERT).
// Invia gli avvisi su Telegram (bot + canale pubblico) e, se configurate, come push del browser.
//
// Secrets:
//   WEBHOOK_SECRET, APP_URL                                  (obbligatori)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID (es. @fiutoterni) (Telegram)
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT        (facoltativi: push del browser)
// Deploy: supabase functions deploy notifica --no-verify-jwt

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { avviso, h, tgEnabled } from '../_shared/telegram.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const APP = Deno.env.get('APP_URL') ?? '/';
const CANALE = Deno.env.get('TELEGRAM_CHANNEL_ID');
const PUSH = !!(Deno.env.get('VAPID_PRIVATE_KEY') && Deno.env.get('VAPID_PUBLIC_KEY'));
if (PUSH) webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') ?? 'mailto:info@example.com', Deno.env.get('VAPID_PUBLIC_KEY')!, Deno.env.get('VAPID_PRIVATE_KEY')!);

const SCAM_RE = /(ricaric|paypal|postepay|bonific|iban|western\s*union|money\s*gram|\bsoldi\b|\beuro\b|€|codice\s*(amazon|regalo|coupon)|gift\s*card|anticip|spese\s*di\s*(spedizione|trasporto)|cauzion|riscatto|ricompens)/i;

type Sub = { endpoint: string; p256dh: string; auth: string; user_id: string };
type Tg = { chat_id: number; user_id: string | null };
type Msg = { title: string; body: string; url: string; tag?: string; foto?: string | null; bottoni?: { text: string; url: string }[][] };

const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const t = (x: number) => x * Math.PI / 180, R = 6371;
  const q = Math.sin(t(b.lat - a.lat) / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(t(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(q));
};

/* ---------- invio push del browser ---------- */
async function push(subs: Sub[], msg: Msg) {
  if (!PUSH) return;
  const seen = new Set<string>();
  await Promise.all(subs.filter(s => !seen.has(s.endpoint) && seen.add(s.endpoint)).map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: msg.title, body: msg.body, url: msg.url, tag: msg.tag }), { TTL: 6 * 3600 });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from('push_iscrizioni').delete().eq('endpoint', s.endpoint);
      else console.error('push', code, (e as Error).message);
    }
  }));
}
/* ---------- invio Telegram ---------- */
async function telegram(utenti: Tg[], msg: Msg) {
  if (!tgEnabled) return;
  const seen = new Set<number>();
  const testo = `<b>${h(msg.title)}</b>\n${h(msg.body)}`;
  const bottoni = msg.bottoni ?? [[{ text: '🐾 Apri in Fiuto', url: msg.url }]];
  for (const u of utenti) {
    if (seen.has(u.chat_id)) continue; seen.add(u.chat_id);
    const ok = await avviso(u.chat_id, testo, bottoni, msg.foto);
    if (!ok) await db.from('telegram_utenti').delete().eq('chat_id', u.chat_id);   // ha bloccato il bot
  }
}
const subsOf = async (ids: string[]) => !PUSH || !ids.length ? [] :
  ((await db.from('push_iscrizioni').select('endpoint,p256dh,auth,user_id').in('user_id', ids)).data ?? []) as Sub[];
const tgOf = async (ids: string[]) => !tgEnabled || !ids.length ? [] :
  ((await db.from('telegram_utenti').select('chat_id,user_id').eq('attivo', true).in('user_id', ids)).data ?? []) as Tg[];
/** manda a una lista di utenti Fiuto su tutti i canali che hanno attivato */
const aUtenti = async (ids: string[], msg: Msg) => { await telegram(await tgOf(ids), msg); await push(await subsOf(ids), msg); };

Deno.serve(async req => {
  if (req.headers.get('x-webhook-secret') !== Deno.env.get('WEBHOOK_SECRET')) return new Response('forbidden', { status: 403 });
  const { type, table, record: r, old_record: old } = await req.json();
  if (!r) return new Response('ignored');

  try {
    /* ===== nuova segnalazione ===== */
    if (table === 'segnalazioni' && type === 'INSERT') {
      const animale = r.specie === 'gatto' ? 'Gatto' : 'Cane';
      const stato = r.tipo === 'perso' ? 'smarrito' : (r.al_sicuro ? 'trovato' : 'avvistato');
      const icona = r.tipo === 'perso' ? '🔴' : '🟢';
      const body = [r.nome && `«${r.nome}»`, r.razza, (r.colori ?? []).join(', '), r.taglia && `taglia ${r.taglia}`, r.descrizione]
        .filter(Boolean).join(' · ').slice(0, 300);
      const url = `${APP}#s-${r.id}`;
      const bottoni = [[{ text: '🐾 Vedi e scrivi in chat', url }],
                       [{ text: r.approssimata ? '📍 Zona sulla mappa' : '📍 Apri in Maps', url: `https://maps.google.com/?q=${r.lat},${r.lng}` }]];
      const base: Msg = { title: '', body, url, foto: r.foto_url, bottoni };

      // 1) possibili match → proprietari delle segnalazioni opposte compatibili
      const { data: opposte } = await db.from('segnalazioni')
        .select('owner_id,lat,lng,microchip_hash')
        .eq('stato', 'attivo').eq('specie', r.specie).neq('tipo', r.tipo).neq('owner_id', r.owner_id)
        .gte('lat', r.lat - 0.15).lte('lat', r.lat + 0.15).gte('lng', r.lng - 0.2).lte('lng', r.lng + 0.2);
      const maxKm = r.specie === 'gatto' ? 4 : 12;
      const match = new Set<string>();
      for (const o of opposte ?? []) {
        const chip = r.microchip_hash && o.microchip_hash;
        if (chip ? r.microchip_hash === o.microchip_hash : km(r, o) <= maxKm) match.add(o.owner_id);
      }
      const tgMatch = await tgOf([...match]);
      await telegram(tgMatch, { ...base, title: `🎯 Possibile match! ${animale} ${stato} a ${km(r, opposte?.find(o => match.has(o.owner_id)) ?? r).toFixed(1).replace('.', ',')} km dalla tua segnalazione` });
      const pushMatch = await subsOf([...match]);
      await push(pushMatch, { ...base, title: '🎯 Possibile match per la tua segnalazione!' });

      // 2) persone in zona (Telegram + push), esclusi autore e chi ha già ricevuto il match
      const titolo = `${icona} ${animale} ${stato} vicino a te`;
      if (tgEnabled) {
        const { data: vicini } = await db.rpc('telegram_vicini', { p_lat: r.lat, p_lng: r.lng, p_specie: r.specie, p_escludi: r.owner_id });
        const gia = new Set(tgMatch.map(t => t.chat_id));
        await telegram(((vicini ?? []) as Tg[]).filter(t => !gia.has(t.chat_id)), { ...base, title: titolo });
      }
      if (PUSH) {
        const { data: vicini } = await db.rpc('iscritti_vicini', { p_lat: r.lat, p_lng: r.lng, p_specie: r.specie, p_escludi: r.owner_id });
        const gia = new Set(pushMatch.map(s => s.endpoint));
        await push(((vicini ?? []) as Sub[]).filter(s => !gia.has(s.endpoint)), { ...base, title: titolo });
      }

      // 3) canale pubblico della città
      if (CANALE) await telegram([{ chat_id: CANALE as unknown as number, user_id: null }],
        { ...base, title: `${icona} ${animale.toUpperCase()} ${stato.toUpperCase()}${r.nome ? ' — ' + r.nome : ''}` });
    }

    /* ===== segnalazione chiusa: lieto fine sul canale ===== */
    if (table === 'segnalazioni' && type === 'UPDATE' && old?.stato === 'attivo' && r.stato === 'risolto' && CANALE) {
      const chi = r.nome ? r.nome : (r.specie === 'gatto' ? 'Il gatto' : 'Il cane');
      await telegram([{ chat_id: CANALE as unknown as number, user_id: null }], {
        title: r.tipo === 'perso' ? `🎉 ${chi} è tornato a casa!` : `🎉 ${chi} ha ritrovato la sua famiglia!`,
        body: 'Grazie a tutti quelli che hanno condiviso e segnalato ❤️', url: APP, foto: r.foto_url,
        bottoni: [[{ text: '🐾 Apri Fiuto', url: APP }]]
      });
    }

    /* ===== nuovo messaggio in chat ===== */
    if (table === 'messaggi' && type === 'INSERT') {
      const { data: c } = await db.from('conversazioni').select('id,owner_id,altro_id,seg_info').eq('id', r.conversazione_id).single();
      if (c) {
        const dest = c.owner_id === r.autore_id ? c.altro_id : c.owner_id;
        const { data: blocco } = await db.from('blocchi').select('blocker_id').eq('blocker_id', dest).eq('blocked_id', r.autore_id).maybeSingle();
        if (!blocco) {
          const url = `${APP}#chat-${c.id}`;
          await aUtenti([dest], {
            title: `💬 Nuovo messaggio · ${c.seg_info?.titolo ?? 'Fiuto'}`,
            body: String(r.testo).slice(0, 300) + (SCAM_RE.test(r.testo) ? '\n\n⚠️ Questo messaggio parla di soldi o pagamenti: non pagare nulla in anticipo, è lo schema tipico delle truffe.' : ''),
            url, tag: 'chat-' + c.id,
            bottoni: [[{ text: '↩️ Rispondi', url }]]
          });
        }
      }
    }
  } catch (e) { console.error(e); }
  return new Response('ok');
});
