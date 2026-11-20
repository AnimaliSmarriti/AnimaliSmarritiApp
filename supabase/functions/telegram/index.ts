// Fiuto — Edge Function "telegram": webhook del bot.
// Collega l'account Fiuto, imposta zona, raggio e animali, mette in pausa gli avvisi.
//
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, APP_URL
// Deploy:  supabase functions deploy telegram --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2';
import { tg } from '../_shared/telegram.ts';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const APP = Deno.env.get('APP_URL') ?? '';

const KB_POSIZIONE = {
  keyboard: [[{ text: '📍 Invia la mia posizione', request_location: true }]],
  resize_keyboard: true, one_time_keyboard: true
};
const KB_RAGGIO = { inline_keyboard: [
  [1, 3, 5].map(k => ({ text: `${k} km`, callback_data: `r:${k}` })),
  [10, 20].map(k => ({ text: `${k} km`, callback_data: `r:${k}` }))
] };
const KB_SPECIE = { inline_keyboard: [[
  { text: '🐶 Cani', callback_data: 's:cane' }, { text: '🐱 Gatti', callback_data: 's:gatto' }, { text: '🐶🐱 Entrambi', callback_data: 's:tutti' }
]] };
const KB_APP = APP ? { inline_keyboard: [[{ text: '🐾 Apri Fiuto', url: APP }]] } : undefined;

const say = (chat_id: number, text: string, reply_markup?: unknown) =>
  tg('sendMessage', { chat_id, text, parse_mode: 'HTML', reply_markup });

async function riga(chat_id: number) {
  const { data } = await db.from('telegram_utenti').select('*').eq('chat_id', chat_id).maybeSingle();
  if (data) return data;
  const { data: nuovo } = await db.from('telegram_utenti').insert({ chat_id }).select('*').single();
  return nuovo;
}

async function stato(chat_id: number) {
  const u = await riga(chat_id);
  const sp = (u.specie as string[]).map(s => s === 'cane' ? '🐶 cani' : '🐱 gatti').join(' e ');
  return say(chat_id,
    `<b>Le tue impostazioni</b>\n` +
    `📍 Zona: ${u.lat == null ? 'non impostata' : 'impostata'}\n📏 Raggio: ${u.raggio_km} km\n🐾 Animali: ${sp}\n` +
    `🔔 Avvisi: ${u.attivo ? 'attivi' : 'in pausa'}\n🔗 Account Fiuto: ${u.user_id ? 'collegato' : 'non collegato'}\n\n` +
    `/zona cambia posizione · /raggio · /animali\n/pausa · /riprendi · /stop per scollegarti`, KB_APP);
}

Deno.serve(async req => {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== Deno.env.get('TELEGRAM_WEBHOOK_SECRET'))
    return new Response('forbidden', { status: 403 });
  const up = await req.json();

  try {
    // ---------- pulsanti ----------
    if (up.callback_query) {
      const q = up.callback_query, chat_id = q.message.chat.id, [k, v] = String(q.data).split(':');
      await riga(chat_id);
      if (k === 'r') {
        await db.from('telegram_utenti').update({ raggio_km: +v }).eq('chat_id', chat_id);
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: `Raggio: ${v} km` });
        await say(chat_id, 'Quali animali ti interessano?', KB_SPECIE);
      } else if (k === 's') {
        await db.from('telegram_utenti').update({ specie: v === 'tutti' ? ['cane', 'gatto'] : [v] }).eq('chat_id', chat_id);
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Fatto ✓' });
        await say(chat_id, '✅ Tutto pronto! Ti scrivo appena c\'è una segnalazione nella tua zona.\n\nScrivi /impostazioni per rivedere tutto.', KB_APP);
      }
      return new Response('ok');
    }

    const m = up.message;
    if (!m || m.chat?.type !== 'private') return new Response('ok');
    const chat_id = m.chat.id;

    // ---------- posizione ----------
    if (m.location) {
      await riga(chat_id);
      await db.from('telegram_utenti').update({ lat: m.location.latitude, lng: m.location.longitude }).eq('chat_id', chat_id);
      await say(chat_id, '📍 Zona salvata! Entro quanti km vuoi ricevere gli avvisi?', KB_RAGGIO);
      return new Response('ok');
    }

    const testo = String(m.text ?? '').trim();
    const [cmd, arg] = testo.split(/\s+/);

    switch (cmd.split('@')[0]) {
      case '/start': {
        let collegato = false;
        if (arg) {
          const { data: c } = await db.from('telegram_codici').select('user_id,created_at').eq('codice', arg).maybeSingle();
          if (c && Date.now() - new Date(c.created_at).getTime() < 30 * 60e3) {
            await db.from('telegram_utenti').update({ user_id: null }).eq('user_id', c.user_id).neq('chat_id', chat_id); // un account = una chat
            await riga(chat_id);
            await db.from('telegram_utenti').update({ user_id: c.user_id, attivo: true }).eq('chat_id', chat_id);
            await db.from('telegram_codici').delete().eq('codice', arg);
            collegato = true;
          } else if (arg) await say(chat_id, '⚠️ Il link è scaduto. Torna su Fiuto → ⚙️ → "Ricevi avvisi su Telegram" e riprova.');
        } else await riga(chat_id);
        const u = await riga(chat_id);
        await say(chat_id,
          (collegato ? '✅ <b>Account Fiuto collegato!</b>\nRiceverai qui i messaggi della chat e i possibili match delle tue segnalazioni.\n\n'
                     : '🐾 <b>Ciao! Sono il bot di Fiuto</b>, la rete di quartiere per cani e gatti smarriti.\n\n') +
          (u.lat == null ? 'Per ricevere gli avvisi degli animali smarriti o avvistati vicino a te, mandami la tua posizione 👇'
                         : 'La tua zona è già impostata. Scrivi /impostazioni per modificarla.'),
          u.lat == null ? KB_POSIZIONE : KB_APP);
        break;
      }
      case '/zona': await say(chat_id, 'Mandami la nuova posizione 👇\n(oppure 📎 → Posizione per sceglierla sulla mappa)', KB_POSIZIONE); break;
      case '/raggio': await say(chat_id, 'Entro quanti km?', KB_RAGGIO); break;
      case '/animali': await say(chat_id, 'Quali animali ti interessano?', KB_SPECIE); break;
      case '/pausa':
        await riga(chat_id); await db.from('telegram_utenti').update({ attivo: false }).eq('chat_id', chat_id);
        await say(chat_id, '⏸️ Avvisi in pausa. Scrivi /riprendi quando vuoi.'); break;
      case '/riprendi':
        await riga(chat_id); await db.from('telegram_utenti').update({ attivo: true }).eq('chat_id', chat_id);
        await say(chat_id, '▶️ Avvisi di nuovo attivi.'); break;
      case '/stop':
        await db.from('telegram_utenti').delete().eq('chat_id', chat_id);
        await say(chat_id, '👋 Ti ho scollegato e cancellato i tuoi dati dal bot. Scrivi /start per ricominciare.', { remove_keyboard: true }); break;
      case '/impostazioni': await stato(chat_id); break;
      default:
        await say(chat_id, 'Comandi: /impostazioni · /zona · /raggio · /animali · /pausa · /riprendi · /stop\n\nPer segnalare un animale o rispondere a una chat usa l\'app 👇', KB_APP);
    }
  } catch (e) { console.error(e); }
  return new Response('ok');   // sempre 200, altrimenti Telegram ripete l'update all'infinito
});
