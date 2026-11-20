// Fiuto — helper Telegram condivisi fra le Edge Functions
const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
export const tgEnabled = !!TOKEN;

export async function tg(method: string, body: Record<string, unknown>) {
  if (!TOKEN) return null;
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!j.ok) console.error('telegram', method, j.description);
  return j;
}

export const h = (s: unknown) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

/** Invia un avviso: con foto se c'è, altrimenti solo testo. Restituisce false se la chat non esiste più. */
export async function avviso(chat_id: number | string, testo: string, bottoni: { text: string; url: string }[][], foto?: string | null) {
  const markup = { inline_keyboard: bottoni };
  const r = foto
    ? await tg('sendPhoto', { chat_id, photo: foto, caption: testo.slice(0, 1024), parse_mode: 'HTML', reply_markup: markup })
    : await tg('sendMessage', { chat_id, text: testo, parse_mode: 'HTML', reply_markup: markup, link_preview_options: { is_disabled: true } });
  // 403 = l'utente ha bloccato il bot; 400 "chat not found"
  return !(r && !r.ok && (r.error_code === 403 || /chat not found/i.test(r.description ?? '')));
}
