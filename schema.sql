-- Fiuto — schema Supabase v3 (chat, sicurezza, microchip, push)
-- Si può rieseguire anche su un database con la v2: usa IF NOT EXISTS / DROP ... IF EXISTS
-- PRIMA: Authentication → Sign In / Providers → abilita "Allow anonymous sign-ins"

create extension if not exists pgcrypto;

-- ============ SEGNALAZIONI ============
create table if not exists public.segnalazioni (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  owner_id     uuid not null default auth.uid(),
  tipo         text not null check (tipo in ('perso','trovato')),
  specie       text not null check (specie in ('cane','gatto')),
  nome         text,
  razza        text,
  colori       text[] default '{}',
  taglia       text check (taglia in ('piccola','media','grande')),
  sesso        text check (sesso in ('M','F','?')),
  collare      boolean,
  al_sicuro    boolean default false,
  descrizione  text,
  contatto     text,                       -- facoltativo: si può usare solo la chat
  foto_url     text,
  lat          double precision not null,
  lng          double precision not null,
  quando       timestamptz not null default now(),
  stato        text not null default 'attivo' check (stato in ('attivo','risolto','nascosto')),
  approssimata boolean not null default false,   -- lat/lng già arrotondate a una cella di ~300 m
  microchip_hash text                            -- SHA-256 del numero, mai il numero in chiaro
);
-- aggiornamento da v2
alter table public.segnalazioni add column if not exists approssimata boolean not null default false;
alter table public.segnalazioni add column if not exists microchip_hash text;
alter table public.segnalazioni drop constraint if exists segnalazioni_stato_check;
alter table public.segnalazioni add constraint segnalazioni_stato_check check (stato in ('attivo','risolto','nascosto'));
create index if not exists segnalazioni_chip_idx on public.segnalazioni (microchip_hash) where microchip_hash is not null;
create index if not exists segnalazioni_attive_idx on public.segnalazioni (stato, quando desc);

alter table public.segnalazioni enable row level security;

drop policy if exists "seg_select" on public.segnalazioni;
create policy "seg_select" on public.segnalazioni for select to authenticated using (true);

drop policy if exists "seg_insert" on public.segnalazioni;
create policy "seg_insert" on public.segnalazioni for insert to authenticated
  with check (owner_id = auth.uid() and stato = 'attivo');

drop policy if exists "seg_update_owner" on public.segnalazioni;
create policy "seg_update_owner" on public.segnalazioni for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

revoke update on public.segnalazioni from authenticated;
grant select, insert on public.segnalazioni to authenticated;
grant update (stato) on public.segnalazioni to authenticated;   -- il proprietario può solo chiuderla

drop policy if exists "seg_update_owner" on public.segnalazioni;
create policy "seg_update_owner" on public.segnalazioni for update to authenticated
  using (owner_id = auth.uid() and stato <> 'nascosto') with check (owner_id = auth.uid() and stato in ('attivo','risolto'));

-- ============ BLOCCHI ============
create table if not exists public.blocchi (
  blocker_id  uuid not null default auth.uid(),
  blocked_id  uuid not null,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);
alter table public.blocchi enable row level security;
drop policy if exists "blocchi_own" on public.blocchi;
create policy "blocchi_own" on public.blocchi for all to authenticated
  using (blocker_id = auth.uid()) with check (blocker_id = auth.uid() and blocked_id <> auth.uid());
grant select, insert, delete on public.blocchi to authenticated;

-- ============ CONVERSAZIONI ============
create table if not exists public.conversazioni (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  last_at          timestamptz not null default now(),
  segnalazione_id  uuid not null references public.segnalazioni(id) on delete cascade,
  owner_id         uuid not null,                       -- autore della segnalazione
  altro_id         uuid not null default auth.uid(),    -- chi gli scrive
  seg_info         jsonb,                               -- titolo/specie/tipo/foto per l'inbox
  unique (segnalazione_id, altro_id)
);
create index if not exists conv_owner_idx on public.conversazioni (owner_id);
create index if not exists conv_altro_idx on public.conversazioni (altro_id);

alter table public.conversazioni enable row level security;

drop policy if exists "conv_select" on public.conversazioni;
create policy "conv_select" on public.conversazioni for select to authenticated
  using (auth.uid() in (owner_id, altro_id));

drop policy if exists "conv_insert" on public.conversazioni;
create policy "conv_insert" on public.conversazioni for insert to authenticated
  with check (
    altro_id = auth.uid()
    and owner_id <> auth.uid()
    and owner_id = (select s.owner_id from public.segnalazioni s where s.id = segnalazione_id)
  );

grant select, insert on public.conversazioni to authenticated;

-- ============ MESSAGGI ============
create table if not exists public.messaggi (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  conversazione_id  uuid not null references public.conversazioni(id) on delete cascade,
  autore_id         uuid not null default auth.uid(),
  testo             text not null check (char_length(testo) between 1 and 2000),
  letto             boolean not null default false
);
create index if not exists msg_conv_idx on public.messaggi (conversazione_id, created_at);

alter table public.messaggi enable row level security;

create or replace function public.partecipa(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from conversazioni c where c.id = conv and auth.uid() in (c.owner_id, c.altro_id));
$$;

drop policy if exists "msg_select" on public.messaggi;
create policy "msg_select" on public.messaggi for select to authenticated
  using (public.partecipa(conversazione_id));

-- si può scrivere solo se si partecipa e l'altra persona non ci ha bloccato
create or replace function public.puo_scrivere(conv uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from conversazioni c
    where c.id = conv and auth.uid() in (c.owner_id, c.altro_id)
      and not exists (
        select 1 from blocchi b
        where b.blocked_id = auth.uid()
          and b.blocker_id = case when c.owner_id = auth.uid() then c.altro_id else c.owner_id end)
  );
$$;

drop policy if exists "msg_insert" on public.messaggi;
create policy "msg_insert" on public.messaggi for insert to authenticated
  with check (autore_id = auth.uid() and public.puo_scrivere(conversazione_id));

drop policy if exists "msg_mark_read" on public.messaggi;
create policy "msg_mark_read" on public.messaggi for update to authenticated
  using (public.partecipa(conversazione_id) and autore_id <> auth.uid());

grant select, insert on public.messaggi to authenticated;
grant update (letto) on public.messaggi to authenticated;

-- aggiorna last_at della conversazione a ogni messaggio
create or replace function public.tocca_conversazione() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update conversazioni set last_at = new.created_at where id = new.conversazione_id;
  return new;
end $$;
drop trigger if exists trg_msg_last_at on public.messaggi;
create trigger trg_msg_last_at after insert on public.messaggi
  for each row execute function public.tocca_conversazione();

-- ============ SEGNALAZIONI DI ABUSO ============
create table if not exists public.abusi (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  autore_id    uuid not null default auth.uid(),
  target_tipo  text not null check (target_tipo in ('segnalazione','utente','messaggio')),
  target_id    uuid not null,
  motivo       text check (char_length(motivo) <= 600),
  unique (autore_id, target_tipo, target_id)
);
alter table public.abusi enable row level security;
drop policy if exists "abusi_insert" on public.abusi;
create policy "abusi_insert" on public.abusi for insert to authenticated with check (autore_id = auth.uid());
grant insert on public.abusi to authenticated;      -- nessuno legge: si consultano dalla dashboard

-- 3 persone diverse segnalano → la segnalazione viene nascosta
create or replace function public.auto_nascondi() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.target_tipo = 'segnalazione'
     and (select count(distinct autore_id) from abusi where target_tipo = 'segnalazione' and target_id = new.target_id) >= 3 then
    update segnalazioni set stato = 'nascosto' where id = new.target_id and stato = 'attivo';
  end if;
  return new;
end $$;
drop trigger if exists trg_auto_nascondi on public.abusi;
create trigger trg_auto_nascondi after insert on public.abusi for each row execute function public.auto_nascondi();

-- ============ ESITI DEI MATCH (è lui / non è lui) ============
create table if not exists public.match_esiti (
  utente_id   uuid not null default auth.uid(),
  seg_a       uuid not null,
  seg_b       uuid not null,
  esito       text not null check (esito in ('si','no')),
  created_at  timestamptz not null default now(),
  primary key (utente_id, seg_a, seg_b)
);
alter table public.match_esiti enable row level security;
drop policy if exists "esiti_own" on public.match_esiti;
create policy "esiti_own" on public.match_esiti for all to authenticated
  using (utente_id = auth.uid()) with check (utente_id = auth.uid());
grant select, insert, update, delete on public.match_esiti to authenticated;

-- ============ LIMITI ANTI-SPAM ============
create or replace function public.limite_frequenza() returns trigger
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if tg_table_name = 'segnalazioni' then
    select count(*) into n from segnalazioni where owner_id = new.owner_id and created_at > now() - interval '24 hours';
    if n >= 5 then raise exception 'Limite raggiunto: massimo 5 segnalazioni al giorno'; end if;
  elsif tg_table_name = 'conversazioni' then
    select count(*) into n from conversazioni where altro_id = new.altro_id and created_at > now() - interval '24 hours';
    if n >= 20 then raise exception 'Limite raggiunto: troppe nuove conversazioni oggi'; end if;
  elsif tg_table_name = 'messaggi' then
    select count(*) into n from messaggi where autore_id = new.autore_id and created_at > now() - interval '10 minutes';
    if n >= 30 then raise exception 'Stai scrivendo troppo velocemente, riprova tra poco'; end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_lim_seg on public.segnalazioni;
create trigger trg_lim_seg before insert on public.segnalazioni for each row execute function public.limite_frequenza();
drop trigger if exists trg_lim_conv on public.conversazioni;
create trigger trg_lim_conv before insert on public.conversazioni for each row execute function public.limite_frequenza();
drop trigger if exists trg_lim_msg on public.messaggi;
create trigger trg_lim_msg before insert on public.messaggi for each row execute function public.limite_frequenza();

-- ============ NOTIFICHE PUSH ============
create table if not exists public.push_iscrizioni (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  user_id     uuid not null default auth.uid(),
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  lat         double precision not null,
  lng         double precision not null,
  raggio_km   int not null default 5 check (raggio_km between 1 and 50),
  specie      text[] not null default '{cane,gatto}'
);
create index if not exists push_user_idx on public.push_iscrizioni (user_id);
alter table public.push_iscrizioni enable row level security;
drop policy if exists "push_own" on public.push_iscrizioni;
create policy "push_own" on public.push_iscrizioni for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.push_iscrizioni to authenticated;

-- usata solo dalla Edge Function (service role)
create or replace function public.iscritti_vicini(p_lat double precision, p_lng double precision, p_specie text, p_escludi uuid)
returns setof public.push_iscrizioni language sql stable security definer set search_path = public as $$
  select * from push_iscrizioni p
  where p.user_id <> p_escludi
    and p_specie = any (p.specie)
    and 6371 * 2 * asin(sqrt(
          power(sin(radians(p_lat - p.lat) / 2), 2) +
          cos(radians(p.lat)) * cos(radians(p_lat)) * power(sin(radians(p_lng - p.lng) / 2), 2)
        )) <= p.raggio_km;
$$;
revoke execute on function public.iscritti_vicini(double precision, double precision, text, uuid) from public, anon, authenticated;

-- ============ REALTIME ============
do $$
declare t text;
begin
  foreach t in array array['segnalazioni','conversazioni','messaggi'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ============ STORAGE FOTO ============
insert into storage.buckets (id, name, public) values ('foto', 'foto', true)
  on conflict (id) do nothing;

drop policy if exists "upload foto" on storage.objects;
create policy "upload foto" on storage.objects for insert to authenticated
  with check (bucket_id = 'foto');
