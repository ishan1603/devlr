-- Sendlr AI — database schema
-- Run in Supabase Dashboard -> SQL Editor. Safe to re-run (idempotent).

-- ===========================================================================
-- user_preferences
-- ===========================================================================

create table if not exists public.user_preferences (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references auth.users (id) on delete cascade,
  email       text not null,
  categories  text[] not null default '{}',
  frequency   text not null default 'weekly'
                check (frequency in ('daily', 'weekly', 'biweekly')),
  send_time   text not null default '09:00',
  timezone    text not null default 'UTC',
  is_active   boolean not null default true,
  last_sent_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Columns added after the initial deploy; no-ops on a fresh database.
alter table public.user_preferences add column if not exists timezone text not null default 'UTC';
alter table public.user_preferences add column if not exists last_sent_at timestamptz;

-- upsert(..., { onConflict: "user_id" }) requires this unique constraint.
create unique index if not exists user_preferences_user_id_key on public.user_preferences (user_id);
create index if not exists user_preferences_active_idx on public.user_preferences (is_active);

-- ===========================================================================
-- newsletter_sends — the idempotency ledger
-- ===========================================================================
-- One row per logical send. `dedupe_key` is UNIQUE, so a duplicate Inngest
-- event, a double-clicked button, or a replayed run collides on insert instead
-- of producing a second email. It doubles as the user-visible send history.

create table if not exists public.newsletter_sends (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  dedupe_key    text not null unique,
  email         text not null,
  send_kind     text not null check (send_kind in ('immediate', 'scheduled', 'recurring')),
  status        text not null default 'sending'
                  check (status in ('sending', 'sent', 'failed', 'skipped')),
  categories    text[] not null default '{}',
  article_count integer,
  error         text,
  run_id        text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);

-- 'skipped' was added after the initial deploy; widening the CHECK is a no-op
-- on a fresh database. A skip is not a failure: it means there was genuinely
-- nothing new to send, and the slot should not be retried all day.
alter table public.newsletter_sends drop constraint if exists newsletter_sends_status_check;
alter table public.newsletter_sends add constraint newsletter_sends_status_check
  check (status in ('sending', 'sent', 'failed', 'skipped'));

create index if not exists newsletter_sends_user_idx    on public.newsletter_sends (user_id, created_at desc);
create index if not exists newsletter_sends_status_idx  on public.newsletter_sends (status);

-- ===========================================================================
-- articles — the shared content pool
-- ===========================================================================
-- Ingestion is separated from delivery. Previously each send fetched its own
-- articles, so N users subscribed to "technology" meant N identical NewsAPI
-- calls and N Groq completions over the same stories -- which exhausts NewsAPI's
-- 100-request free tier at roughly 25 daily users. Articles are now fetched once
-- per category per window into this table, and each send assembles from it.

create table if not exists public.articles (
  id           uuid primary key default gen_random_uuid(),
  url          text not null,
  category     text not null,
  title        text not null,
  description  text,
  source       text,
  published_at timestamptz,
  fetched_at   timestamptz not null default now(),
  -- The same story can legitimately belong to two categories, so the natural
  -- key is the pair, not the URL alone.
  unique (url, category)
);

create index if not exists articles_category_fresh_idx
  on public.articles (category, published_at desc nulls last);
create index if not exists articles_fetched_idx on public.articles (fetched_at desc);

-- ===========================================================================
-- newsletter_send_articles — what each user has already been shown
-- ===========================================================================
-- Send-level dedupe stops the same *newsletter* going out twice.
-- This is the content-level counterpart: it stops the same *story* appearing in
-- two different issues for one reader.

create table if not exists public.newsletter_send_articles (
  send_id    uuid not null references public.newsletter_sends (id) on delete cascade,
  article_id uuid not null references public.articles (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (send_id, article_id)
);

create index if not exists newsletter_send_articles_seen_idx
  on public.newsletter_send_articles (user_id, article_id);

-- ---------------------------------------------------------------------------
-- Dedupe by story URL, not by article row
-- ---------------------------------------------------------------------------
-- `articles` is keyed (url, category), so one story filed under two categories
-- is two rows with two ids. Tracking article_id therefore let the same URL
-- reach a reader twice. The durable identity of a story is its URL.
--
-- article_id also becomes nullable with ON DELETE SET NULL: under the old
-- CASCADE, pruning an old article deleted the record that the reader had
-- already seen it, and the story could come back.

alter table public.newsletter_send_articles add column if not exists article_url text;

update public.newsletter_send_articles nsa
   set article_url = a.url
  from public.articles a
 where a.id = nsa.article_id and nsa.article_url is null;

alter table public.newsletter_send_articles drop constraint if exists newsletter_send_articles_pkey;
alter table public.newsletter_send_articles add column if not exists id uuid default gen_random_uuid();
update public.newsletter_send_articles set id = gen_random_uuid() where id is null;
alter table public.newsletter_send_articles alter column id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.newsletter_send_articles'::regclass and contype = 'p'
  ) then
    alter table public.newsletter_send_articles add primary key (id);
  end if;
end $$;

alter table public.newsletter_send_articles drop constraint if exists newsletter_send_articles_article_id_fkey;
alter table public.newsletter_send_articles alter column article_id drop not null;
alter table public.newsletter_send_articles
  add constraint newsletter_send_articles_article_id_fkey
  foreign key (article_id) references public.articles (id) on delete set null;

-- Collapse rows that already violate the rule before enforcing it.
-- These exist precisely because of the bug this index closes: a story filed
-- under two categories was recorded twice for the same send. Keep one of each.
delete from public.newsletter_send_articles a
 using public.newsletter_send_articles b
 where a.ctid > b.ctid
   and a.send_id = b.send_id
   and a.article_url = b.article_url;

-- Rows whose article was already pruned carry no URL, so they can no longer
-- protect anyone from a repeat. They only add noise.
delete from public.newsletter_send_articles where article_url is null;

-- One row per (send, story). This is what actually guarantees "never the same
-- article twice".
create unique index if not exists newsletter_send_articles_send_url_key
  on public.newsletter_send_articles (send_id, article_url);
create index if not exists newsletter_send_articles_seen_url_idx
  on public.newsletter_send_articles (user_id, article_url);

-- ---------------------------------------------------------------------------
-- Unsubscribe + free-form cadence
-- ---------------------------------------------------------------------------
-- An unguessable per-user token: it lets List-Unsubscribe and the footer link
-- work without a login, which mailbox providers weigh heavily, without exposing
-- the user id.

alter table public.user_preferences
  add column if not exists unsubscribe_token uuid not null default gen_random_uuid();
create unique index if not exists user_preferences_unsub_token_key
  on public.user_preferences (unsubscribe_token);

-- "Every N days", used when frequency = 'custom'.
alter table public.user_preferences add column if not exists custom_interval_days integer;

alter table public.user_preferences drop constraint if exists user_preferences_frequency_check;
alter table public.user_preferences add constraint user_preferences_frequency_check
  check (frequency in ('daily', 'weekly', 'biweekly', 'monthly', 'custom'));

-- ===========================================================================
-- updated_at trigger
-- ===========================================================================

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_preferences_set_updated_at on public.user_preferences;
create trigger user_preferences_set_updated_at
  before update on public.user_preferences
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
-- Without this, the anon key -- which ships to every browser -- can read and
-- write every row, including every user's email address.
--
-- The service-role key bypasses RLS by design; that is what lib/supabase-admin.ts
-- uses so background jobs can still read preferences with no cookies present.

alter table public.user_preferences enable row level security;
alter table public.newsletter_sends enable row level security;

drop policy if exists "own prefs: select" on public.user_preferences;
create policy "own prefs: select" on public.user_preferences
  for select using (auth.uid() = user_id);

drop policy if exists "own prefs: insert" on public.user_preferences;
create policy "own prefs: insert" on public.user_preferences
  for insert with check (auth.uid() = user_id);

drop policy if exists "own prefs: update" on public.user_preferences;
create policy "own prefs: update" on public.user_preferences
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own prefs: delete" on public.user_preferences;
create policy "own prefs: delete" on public.user_preferences
  for delete using (auth.uid() = user_id);

-- Send history is read-only to its owner. Writes come only from the service
-- role (background jobs), so there is deliberately no insert/update policy.
drop policy if exists "own sends: select" on public.newsletter_sends;
create policy "own sends: select" on public.newsletter_sends
  for select using (auth.uid() = user_id);

-- Articles are shared, non-sensitive content: any signed-in user may read the
-- pool (this is what a future "browse" surface would use). Only the service
-- role writes to it.
alter table public.articles enable row level security;
drop policy if exists "articles: read" on public.articles;
create policy "articles: read" on public.articles
  for select to authenticated using (true);

alter table public.newsletter_send_articles enable row level security;
drop policy if exists "own seen: select" on public.newsletter_send_articles;
create policy "own seen: select" on public.newsletter_send_articles
  for select using (auth.uid() = user_id);
