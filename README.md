# 🐾 Fiuto — cani e gatti smarriti

Web app (PWA) stile Waze: chi ha perso un animale e chi lo ha visto o trovato lo segnalano sulla mappa, l'app propone i match e i due si scrivono in chat.

## File
| File | A cosa serve |
|---|---|
| `index.html` | Tutta l'app (HTML + CSS + JS) |
| `sw.js` | Service worker per le notifiche push |
| `manifest.webmanifest`, `icon-192.png`, `icon-512.png` | Installazione su Home (obbligatoria su iPhone per le push) |
| `schema.sql` | Database Supabase v3 (rieseguibile anche sopra la v2) |
| `supabase/functions/notifica/index.ts` | Edge Function che invia gli avvisi (Telegram + push) |
| `supabase/functions/telegram/index.ts` | Edge Function: webhook del bot Telegram |
| `supabase/functions/_shared/telegram.ts` | Funzioni comuni per Telegram |

Senza configurazione gira in **modalità demo** (dati nel browser, chat simulata).

## Messa online (Supabase)

1. **Auth → Sign In / Providers**: attiva *Allow anonymous sign-ins*. Consigliato: attiva anche il CAPTCHA (Turnstile) in *Auth → Attack Protection*, così nessuno crea migliaia di account anonimi.
2. **Auth → URL Configuration**: imposta *Site URL* sull'indirizzo dell'app (serve per i link email).
3. **SQL Editor**: esegui `schema.sql`.
4. In `index.html`, nell'oggetto `CONFIG`, inserisci `SUPABASE_URL` e `SUPABASE_ANON_KEY`.
5. Pubblica la cartella (Netlify, ecc.). Serve HTTPS, e `sw.js` deve stare nella stessa cartella di `index.html`.

## Avvisi su Telegram (consigliato)

1. Su Telegram apri **@BotFather** → `/newbot` → scegli nome e username (es. `FiutoTerniBot`) → copia il **token**.
   Sempre da BotFather: `/setcommands` e incolla:
   ```
   impostazioni - Vedi le tue impostazioni
   zona - Cambia la tua posizione
   raggio - Cambia il raggio degli avvisi
   animali - Cani, gatti o entrambi
   pausa - Metti in pausa gli avvisi
   riprendi - Riattiva gli avvisi
   stop - Scollegati e cancella i dati
   ```
2. (Facoltativo) Crea un **canale pubblico** (es. `@fiutoterni`) e aggiungi il bot come **amministratore** con il permesso di pubblicare.
3. Secrets e deploy (con Supabase CLI):
   ```bash
   supabase secrets set TELEGRAM_BOT_TOKEN=123:ABC... TELEGRAM_WEBHOOK_SECRET=una-stringa-a-caso \
     TELEGRAM_CHANNEL_ID=@fiutoterni APP_URL=https://tuo-sito.netlify.app/ WEBHOOK_SECRET=altra-stringa-a-caso
   supabase functions deploy telegram --no-verify-jwt
   supabase functions deploy notifica --no-verify-jwt
   ```
4. Collega il bot alla funzione (una volta sola, dal browser va bene):
   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<progetto>.supabase.co/functions/v1/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>
   ```
   Deve rispondere `"ok":true`.
5. **Database → Webhooks**, crea 2 webhook verso la Edge Function `notifica` (POST, header `x-webhook-secret: <WEBHOOK_SECRET>`):
   - tabella `segnalazioni`, eventi **Insert** e **Update**
   - tabella `messaggi`, evento **Insert**
6. In `index.html` → `CONFIG`: `TELEGRAM_BOT: 'FiutoTerniBot'` e `TELEGRAM_CANALE: 'fiutoterni'` (senza @).

Cosa arriva su Telegram (con foto e pulsanti):
- **🎯 Possibile match** → a chi ha una segnalazione compatibile (account collegato)
- **🔴/🟢 Segnalazione vicino a te** → a chi ha mandato la posizione al bot, nel suo raggio (anche senza account Fiuto)
- **💬 Nuovo messaggio** → con avviso anti-truffa se parla di soldi; mai da persone bloccate
- **Canale**: ogni nuova segnalazione, e il post "🎉 è tornato a casa!" quando viene chiusa

Il collegamento: Fiuto → ⚙️ → *Ricevi avvisi su Telegram* → si apre il bot con un codice monouso (vale 30 minuti) → *Avvia* → manda la posizione → scegli raggio e animali.

## Push del browser (facoltativo, alternativa per Android)

```bash
npx web-push generate-vapid-keys
supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:tua@email.it
supabase functions deploy notifica --no-verify-jwt
```
Metti la chiave pubblica anche in `CONFIG.VAPID_PUBLIC_KEY`. Su iPhone funzionano solo con l'app aggiunta alla Home: per questo Telegram è il canale principale.

## Sicurezza e privacy
- **Posizione approssimata**: i ritrovamenti "al sicuro" (e chi la attiva) salvano solo il centro di una cella di circa 300 m. Il punto esatto non arriva mai nel database.
- **Microchip**: si salva solo un hash SHA-256, il numero non è mai visibile. Due hash uguali danno un match al 100%.
- **Foto**: vengono ridimensionate nel browser, quindi i dati EXIF col GPS non vengono caricati.
- **Chat**: con la RLS ogni conversazione la vedono solo i due partecipanti. Si può bloccare una persona (il database rifiuta i suoi messaggi) e segnalarla.
- **Anti-truffa**: avviso fisso in chat, più un avviso automatico sui messaggi che parlano di soldi, ricariche, IBAN, ecc.
- **Moderazione**: dopo 3 segnalazioni di abuso da persone diverse la segnalazione viene nascosta. Le segnalazioni di abuso si leggono nella tabella `abusi`.
- **Limiti anti-spam**: 5 segnalazioni al giorno, 20 nuove chat al giorno, 30 messaggi ogni 10 minuti per utente.
- **Telegram**: il bot salva solo chat, posizione scelta, raggio e animali. `/stop` cancella tutto; se un utente blocca il bot viene rimosso in automatico.
- **Account**: si parte anonimi. Da ⚙️ si collega un'email (magic link, senza password) per ritrovare segnalazioni e chat su un altro dispositivo.

## Link diretti
- `#s-<id>` apre una segnalazione (è il link usato dal QR del volantino)
- `#chat-<id>` apre una conversazione (è il link usato dalle notifiche)
