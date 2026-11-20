# 🐾 Fiuto — cani e gatti smarriti

Web app (PWA) stile Waze: chi ha perso un animale e chi lo ha visto o trovato lo segnalano sulla mappa, l'app propone i match e i due si scrivono in chat.

## File
| File | A cosa serve |
|---|---|
| `index.html` | Tutta l'app (HTML + CSS + JS) |
| `sw.js` | Service worker per le notifiche push |
| `manifest.webmanifest`, `icon-192.png`, `icon-512.png` | Installazione su Home (obbligatoria su iPhone per le push) |
| `schema.sql` | Database Supabase v3 (rieseguibile anche sopra la v2) |
| `supabase/functions/notifica/index.ts` | Edge Function che invia le push |

Senza configurazione gira in **modalità demo** (dati nel browser, chat simulata).

## Messa online (Supabase)

1. **Auth → Sign In / Providers**: attiva *Allow anonymous sign-ins*. Consigliato: attiva anche il CAPTCHA (Turnstile) in *Auth → Attack Protection*, così nessuno crea migliaia di account anonimi.
2. **Auth → URL Configuration**: imposta *Site URL* sull'indirizzo dell'app (serve per i link email).
3. **SQL Editor**: esegui `schema.sql`.
4. In `index.html`, nell'oggetto `CONFIG`, inserisci `SUPABASE_URL` e `SUPABASE_ANON_KEY`.
5. Pubblica la cartella (Netlify, ecc.). Serve HTTPS, e `sw.js` deve stare nella stessa cartella di `index.html`.

## Notifiche push

```bash
npx web-push generate-vapid-keys          # ottieni la chiave pubblica e quella privata
supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
  VAPID_SUBJECT=mailto:tua@email.it APP_URL=https://tuo-sito/ WEBHOOK_SECRET=una-stringa-a-caso
supabase functions deploy notifica --no-verify-jwt
```
- Metti la chiave pubblica anche in `CONFIG.VAPID_PUBLIC_KEY`.
- **Database → Webhooks**: crea due webhook, uno su *INSERT* in `segnalazioni` e uno su *INSERT* in `messaggi`. Tipo: Supabase Edge Function `notifica`, metodo POST, header `x-webhook-secret: <la stessa stringa>`.

Chi attiva le notifiche (⚙️ → Avvisi in zona) riceve:
- **🎯 Possibile match** quando compare una segnalazione compatibile con la sua (stessa specie, entro 12 km per i cani e 4 km per i gatti, oppure stesso microchip);
- **nuove segnalazioni** entro il raggio che ha scelto;
- **💬 nuovi messaggi**, a meno che non abbia bloccato il mittente.

Su iPhone le push funzionano solo dopo aver aggiunto l'app alla schermata Home (iOS 16.4 o successivo).

## Sicurezza e privacy
- **Posizione approssimata**: i ritrovamenti "al sicuro" (e chi la attiva) salvano solo il centro di una cella di circa 300 m. Il punto esatto non arriva mai nel database.
- **Microchip**: si salva solo un hash SHA-256, il numero non è mai visibile. Due hash uguali danno un match al 100%.
- **Foto**: vengono ridimensionate nel browser, quindi i dati EXIF col GPS non vengono caricati.
- **Chat**: con la RLS ogni conversazione la vedono solo i due partecipanti. Si può bloccare una persona (il database rifiuta i suoi messaggi) e segnalarla.
- **Anti-truffa**: avviso fisso in chat, più un avviso automatico sui messaggi che parlano di soldi, ricariche, IBAN, ecc.
- **Moderazione**: dopo 3 segnalazioni di abuso da persone diverse la segnalazione viene nascosta. Le segnalazioni di abuso si leggono nella tabella `abusi`.
- **Limiti anti-spam**: 5 segnalazioni al giorno, 20 nuove chat al giorno, 30 messaggi ogni 10 minuti per utente.
- **Account**: si parte anonimi. Da ⚙️ si collega un'email (magic link, senza password) per ritrovare segnalazioni e chat su un altro dispositivo.

## Link diretti
- `#s-<id>` apre una segnalazione (è il link usato dal QR del volantino)
- `#chat-<id>` apre una conversazione (è il link usato dalle notifiche)
