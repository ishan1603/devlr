-- Devlr core schema
-- Applied by `npm run db:migrate`. Idempotent: every statement can be re-run.
--
-- Shape of the system, in one paragraph: content is ingested into a shared pool
-- (`content_items`), enriched once (embedding, cluster, summary), and each
-- user's issue is *assembled* from that pool. Nothing here is generated per
-- user except the final selection, which is why cost scales with content and
-- not with subscribers.

create extension if not exists vector with schema extensions;

-- ===========================================================================
-- updated_at
-- ===========================================================================

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ===========================================================================
-- profiles: one row per account
-- ===========================================================================
-- `send_time` and `timezone` live here rather than on each subscription on
-- purpose. Modules have their own cadence, but everything due on the same day
-- has to leave in ONE email, and that only works if there is a single moment
-- per user at which "what is due today" is evaluated.

create table if not exists public.profiles (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  email          text not null,
  display_name   text,
  level          text not null default 'mid'
                   check (level in ('student', 'junior', 'mid', 'senior', 'staff')),
  -- Slugs from lib/topics/catalog.ts. Arrays rather than a join table: they are
  -- always read and written whole, and a GIN index covers the one query that
  -- needs to look inside them (which tags does any active user want).
  domains        text[] not null default '{}',
  stack          text[] not null default '{}',
  digest_length  text not null default 'standard'
                   check (digest_length in ('short', 'standard', 'long')),
  timezone       text not null default 'UTC',
  send_time      text not null default '08:00' check (send_time ~ '^\d{2}:\d{2}$'),
  is_paused      boolean not null default false,
  onboarding_step text not null default 'domains',
  onboarded_at   timestamptz,
  -- Unguessable tokens. Each authorises exactly one thing without a session:
  -- stopping all mail, and reading this user's issue feed.
  unsubscribe_token uuid not null default gen_random_uuid(),
  feed_token        uuid not null default gen_random_uuid(),
  -- What this reader cares about, as a vector. Built from domains + stack and
  -- nudged by feedback; relevance ranking is a cosine against it.
  interest_text      text,
  interest_embedding extensions.halfvec(768),
  last_delivery_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists profiles_unsubscribe_token_key on public.profiles (unsubscribe_token);
create unique index if not exists profiles_feed_token_key on public.profiles (feed_token);
create index if not exists profiles_active_idx on public.profiles (is_paused) where onboarded_at is not null;
create index if not exists profiles_stack_idx on public.profiles using gin (stack);
create index if not exists profiles_domains_idx on public.profiles using gin (domains);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- A profile exists from the moment the account does, so no code path has to
-- handle "signed in but no row yet". SECURITY DEFINER because the insert runs
-- as the auth service, which has no rights on public.profiles.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, email, display_name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'user_name', new.raw_user_meta_data ->> 'full_name')
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===========================================================================
-- subscriptions: which modules a user receives, and how often
-- ===========================================================================

create table if not exists public.subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  module      text not null check (module in (
                'digest', 'dev_pulse', 'eol_watch', 'repo_guard',
                'release_radar', 'learn', 'company_radar')),
  is_active   boolean not null default true,
  frequency   text not null default 'weekly' check (frequency in (
                'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'custom')),
  custom_interval_days integer check (custom_interval_days between 1 and 90),
  settings    jsonb not null default '{}',
  -- Per-module unsubscribe: a reader can stop Learn without stopping security
  -- alerts. The profile token above stops everything.
  unsubscribe_token uuid not null default gen_random_uuid(),
  last_sent_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, module)
);

create unique index if not exists subscriptions_unsubscribe_token_key on public.subscriptions (unsubscribe_token);
create index if not exists subscriptions_active_idx on public.subscriptions (module) where is_active;

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- sources: where content comes from
-- ===========================================================================
-- The registry itself lives in code (lib/sources/registry.ts) and is synced
-- here, so adding a feed is a reviewed diff. This table holds what code cannot:
-- the HTTP validators and the health of each source.

create table if not exists public.sources (
  id          text primary key,
  kind        text not null,
  name        text not null,
  url         text not null,
  site_url    text,
  category    text not null default 'blog',
  topics      text[] not null default '{}',
  quality     real not null default 0.6 check (quality between 0 and 1),
  -- Conditional-GET validators. A feed that has not changed answers 304 with no
  -- body, which is most fetches, and is the polite way to poll someone's site.
  etag          text,
  last_modified text,
  last_fetched_at timestamptz,
  last_success_at timestamptz,
  error_count integer not null default 0,
  last_error  text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ===========================================================================
-- content_clusters + content_items: the shared pool
-- ===========================================================================
-- A cluster is "one story". Five outlets covering the same release are five
-- items in one cluster, and a reader is shown the cluster once.

create table if not exists public.content_clusters (
  id            uuid primary key default gen_random_uuid(),
  item_count    integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create table if not exists public.content_items (
  id            uuid primary key default gen_random_uuid(),
  -- Tracking params stripped, host normalised. This is the identity of an
  -- article; `url` is what we actually link to.
  canonical_url text not null unique,
  url           text not null,
  title         text not null,
  description   text,
  -- Extracted main text, truncated. Only needed until the summary is written,
  -- then nulled to stay inside the 500 MB free tier.
  body_excerpt  text,
  source_id     text references public.sources (id) on delete set null,
  source_name   text,
  site          text,
  author        text,
  kind          text not null default 'blog' check (kind in (
                  'news', 'blog', 'tutorial', 'release', 'paper', 'discussion', 'repo')),
  tags          text[] not null default '{}',
  popularity    jsonb not null default '{}',
  pop_score     real not null default 0,
  -- 64-bit SimHash of the normalised title, for catching reposts before paying
  -- for an embedding.
  title_hash    bigint,
  embedding     extensions.halfvec(768),
  cluster_id    uuid references public.content_clusters (id) on delete set null,
  summary       text,
  quality       smallint check (quality between 1 and 5),
  reading_minutes smallint,
  summary_model text,
  status        text not null default 'new' check (status in ('new', 'enriched', 'rejected')),
  published_at  timestamptz,
  fetched_at    timestamptz not null default now(),
  enriched_at   timestamptz
);

create index if not exists content_items_published_idx on public.content_items (published_at desc nulls last);
create index if not exists content_items_status_idx on public.content_items (status, fetched_at desc);
create index if not exists content_items_tags_idx on public.content_items using gin (tags);
create index if not exists content_items_cluster_idx on public.content_items (cluster_id);
create index if not exists content_items_title_hash_idx on public.content_items (title_hash);
create index if not exists content_items_embedding_idx on public.content_items
  using hnsw (embedding extensions.halfvec_cosine_ops);

-- Nearest already-clustered neighbours of a new item, within a time window.
-- Used at ingest to decide "same story as something we already have".
create or replace function public.match_recent_items(
  p_embedding extensions.halfvec(768),
  p_since     timestamptz,
  p_exclude   uuid,
  p_limit     integer default 5
)
returns table (id uuid, cluster_id uuid, title text, similarity real)
language sql stable
set search_path = public, extensions
as $$
  select c.id, c.cluster_id, c.title,
         (1 - (c.embedding <=> p_embedding))::real as similarity
    from public.content_items c
   where c.embedding is not null
     and c.id <> p_exclude
     and coalesce(c.published_at, c.fetched_at) >= p_since
   order by c.embedding <=> p_embedding
   limit p_limit;
$$;

-- Another article joined an existing story.
create or replace function public.touch_cluster(p_cluster_id uuid)
returns void
language sql
set search_path = public
as $$
  update public.content_clusters
     set item_count = item_count + 1, last_seen_at = now()
   where id = p_cluster_id;
$$;

-- Which of these URLs are already in the pool. A function rather than a
-- `canonical_url=in.(...)` filter because a hundred URLs do not fit in a query
-- string, and this takes them in a POST body.
create or replace function public.existing_items(p_urls text[])
returns table (
  id uuid, canonical_url text, source_id text, popularity jsonb, pop_score real, tags text[]
)
language sql stable
set search_path = public
as $$
  select c.id, c.canonical_url, c.source_id, c.popularity, c.pop_score, c.tags
    from public.content_items c
   where c.canonical_url = any (p_urls);
$$;

-- The candidate set for one reader's digest: everything recent that either
-- shares a tag with them or sits near their interest vector. Ranking proper
-- happens in TypeScript (lib/content/rank.ts); this only narrows a week of
-- content to a few hundred rows, in one round trip.
create or replace function public.digest_candidates(
  p_tags      text[],
  p_embedding extensions.halfvec(768),
  p_since     timestamptz,
  p_limit     integer default 150
)
returns table (
  id uuid, cluster_id uuid, canonical_url text, url text, title text, summary text,
  source_id text, source_name text, site text, kind text, tags text[],
  popularity jsonb, pop_score real, quality smallint, reading_minutes smallint,
  published_at timestamptz, fetched_at timestamptz,
  source_quality real, similarity real
)
language sql stable
set search_path = public, extensions
as $$
  with by_tags as (
    select c.id
      from public.content_items c
     where c.status = 'enriched'
       and c.summary is not null
       and coalesce(c.published_at, c.fetched_at) >= p_since
       and c.tags && p_tags
     order by c.pop_score desc, coalesce(c.published_at, c.fetched_at) desc
     limit p_limit
  ),
  by_vector as (
    select c.id
      from public.content_items c
     where p_embedding is not null
       and c.status = 'enriched'
       and c.summary is not null
       and c.embedding is not null
       and coalesce(c.published_at, c.fetched_at) >= p_since
     order by c.embedding <=> p_embedding
     limit p_limit
  )
  select c.id, c.cluster_id, c.canonical_url, c.url, c.title, c.summary,
         c.source_id, c.source_name, c.site, c.kind, c.tags,
         c.popularity, c.pop_score, c.quality, c.reading_minutes,
         c.published_at, c.fetched_at,
         coalesce(s.quality, 0.5)::real as source_quality,
         case when p_embedding is null or c.embedding is null then null
              else (1 - (c.embedding <=> p_embedding))::real end as similarity
    from public.content_items c
    left join public.sources s on s.id = c.source_id
   where c.id in (select id from by_tags union select id from by_vector);
$$;

-- ===========================================================================
-- deliveries: the idempotency ledger, send history, and archive
-- ===========================================================================
-- One row per logical email. `dedupe_key` is UNIQUE, so a duplicate event, a
-- double click, or a replayed run collides on INSERT instead of producing a
-- second email. `payload` is the structured issue, which is what the web view
-- and the personal feed render from.

create table if not exists public.deliveries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  dedupe_key  text not null unique,
  kind        text not null check (kind in ('scheduled', 'manual', 'urgent', 'preview')),
  modules     text[] not null default '{}',
  status      text not null default 'sending'
                check (status in ('sending', 'sent', 'failed', 'skipped')),
  subject     text,
  preheader   text,
  payload     jsonb,
  item_count  integer,
  web_token   uuid not null default gen_random_uuid(),
  error       text,
  run_id      text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

create unique index if not exists deliveries_web_token_key on public.deliveries (web_token);
create index if not exists deliveries_user_idx on public.deliveries (user_id, created_at desc);
create index if not exists deliveries_status_idx on public.deliveries (status);

-- What each reader has already been shown. `ref` is the cluster id for content
-- (so the same story from another outlet stays out too), and a module-specific
-- key for everything else, e.g. `nodejs:20:30d` for an EOL milestone.
create table if not exists public.delivery_items (
  id          bigint generated always as identity primary key,
  delivery_id uuid not null references public.deliveries (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  module      text not null,
  item_type   text not null,
  ref         text not null,
  canonical_url text,
  created_at  timestamptz not null default now(),
  unique (delivery_id, item_type, ref)
);

create index if not exists delivery_items_seen_idx on public.delivery_items (user_id, item_type, ref);
create index if not exists delivery_items_seen_url_idx on public.delivery_items (user_id, canonical_url);

-- ===========================================================================
-- feedback: "more like this" / "less like this"
-- ===========================================================================
-- Tags and source are copied onto the row because content is pruned after 60
-- days and the preference has to outlive the article that taught it to us.

create table if not exists public.feedback (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  item_ref    text not null,
  signal      smallint not null check (signal in (-1, 1)),
  tags        text[] not null default '{}',
  source_id   text,
  site        text,
  created_at  timestamptz not null default now(),
  unique (user_id, item_ref)
);

create index if not exists feedback_user_idx on public.feedback (user_id, created_at desc);

-- ===========================================================================
-- Dev Pulse: trending repositories, per language, per week
-- ===========================================================================

create table if not exists public.pulse_repos (
  id          bigint generated always as identity primary key,
  week        date not null,
  language    text not null,
  full_name   text not null,
  url         text not null,
  description text,
  stars       integer not null default 0,
  forks       integer not null default 0,
  topics      text[] not null default '{}',
  repo_created_at timestamptz,
  blurb       text,
  rank        smallint not null default 0,
  fetched_at  timestamptz not null default now(),
  unique (week, language, full_name)
);

create index if not exists pulse_repos_week_idx on public.pulse_repos (week desc, language, rank);

-- ===========================================================================
-- EOL Watch: release lifecycles, cached from endoflife.date
-- ===========================================================================

create table if not exists public.eol_cycles (
  product      text not null,
  cycle        text not null,
  label        text,
  release_date date,
  eol_date     date,
  is_lts       boolean not null default false,
  latest       text,
  link         text,
  updated_at   timestamptz not null default now(),
  primary key (product, cycle)
);

create index if not exists eol_cycles_eol_idx on public.eol_cycles (eol_date);

-- ===========================================================================
-- LLM plumbing: replay cache and free-tier budget
-- ===========================================================================
-- The cache is what makes a retried Inngest step free: calls that already
-- completed are served from here instead of being paid for twice.

create table if not exists public.llm_cache (
  key         text primary key,
  task        text not null,
  provider    text,
  model       text,
  output      jsonb not null,
  tokens      integer,
  created_at  timestamptz not null default now()
);

create index if not exists llm_cache_created_idx on public.llm_cache (created_at);

create table if not exists public.provider_usage (
  provider    text not null,
  model       text not null,
  day         date not null,
  requests    integer not null default 0,
  tokens      integer not null default 0,
  primary key (provider, model, day)
);

-- Read-modify-write from TypeScript would lose counts under concurrency; an
-- upsert with arithmetic in the database does not.
create or replace function public.bump_provider_usage(
  p_provider text, p_model text, p_day date, p_requests integer, p_tokens integer
)
returns void
language sql
set search_path = public
as $$
  insert into public.provider_usage (provider, model, day, requests, tokens)
  values (p_provider, p_model, p_day, p_requests, p_tokens)
  on conflict (provider, model, day)
  do update set requests = public.provider_usage.requests + excluded.requests,
                tokens   = public.provider_usage.tokens + excluded.tokens;
$$;

-- ===========================================================================
-- Retention
-- ===========================================================================
-- The free tier is 500 MB. Content is only useful while it is fresh; what has
-- to survive is the memory of what each reader was shown, and that lives in
-- delivery_items (tiny rows, no foreign key to content).

create or replace function public.prune_old_data(p_content_days integer default 60)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_items integer; v_clusters integer; v_payloads integer; v_cache integer; v_pulse integer;
begin
  delete from public.content_items
   where coalesce(published_at, fetched_at) < now() - make_interval(days => p_content_days);
  get diagnostics v_items = row_count;

  delete from public.content_clusters c
   where not exists (select 1 from public.content_items i where i.cluster_id = c.id);
  get diagnostics v_clusters = row_count;

  -- Archived issues stay readable for 120 days, then keep only their metadata.
  update public.deliveries set payload = null
   where payload is not null and created_at < now() - interval '120 days';
  get diagnostics v_payloads = row_count;

  delete from public.llm_cache where created_at < now() - interval '30 days';
  get diagnostics v_cache = row_count;

  delete from public.pulse_repos where week < (current_date - 60);
  get diagnostics v_pulse = row_count;

  delete from public.provider_usage where day < (current_date - 90);

  return jsonb_build_object(
    'content_items', v_items, 'clusters', v_clusters,
    'payloads_cleared', v_payloads, 'llm_cache', v_cache, 'pulse', v_pulse);
end;
$$;

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
-- The anon key ships to every browser. Without RLS it can read every row,
-- including every user's email. Background jobs use the service-role client
-- (lib/supabase-admin.ts), which bypasses RLS by design.

alter table public.profiles        enable row level security;
alter table public.subscriptions   enable row level security;
alter table public.deliveries      enable row level security;
alter table public.delivery_items  enable row level security;
alter table public.feedback        enable row level security;
alter table public.sources         enable row level security;
alter table public.content_items   enable row level security;
alter table public.content_clusters enable row level security;
alter table public.pulse_repos     enable row level security;
alter table public.eol_cycles      enable row level security;
-- No policies at all on these two: service role only.
alter table public.llm_cache       enable row level security;
alter table public.provider_usage  enable row level security;

drop policy if exists "own profile: select" on public.profiles;
create policy "own profile: select" on public.profiles
  for select using (auth.uid() = user_id);

drop policy if exists "own profile: update" on public.profiles;
create policy "own profile: update" on public.profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own subscriptions: select" on public.subscriptions;
create policy "own subscriptions: select" on public.subscriptions
  for select using (auth.uid() = user_id);

drop policy if exists "own subscriptions: insert" on public.subscriptions;
create policy "own subscriptions: insert" on public.subscriptions
  for insert with check (auth.uid() = user_id);

drop policy if exists "own subscriptions: update" on public.subscriptions;
create policy "own subscriptions: update" on public.subscriptions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own subscriptions: delete" on public.subscriptions;
create policy "own subscriptions: delete" on public.subscriptions
  for delete using (auth.uid() = user_id);

-- History is read-only to its owner. Writes come only from background jobs.
drop policy if exists "own deliveries: select" on public.deliveries;
create policy "own deliveries: select" on public.deliveries
  for select using (auth.uid() = user_id);

drop policy if exists "own delivery items: select" on public.delivery_items;
create policy "own delivery items: select" on public.delivery_items
  for select using (auth.uid() = user_id);

drop policy if exists "own feedback: select" on public.feedback;
create policy "own feedback: select" on public.feedback
  for select using (auth.uid() = user_id);

-- Shared, non-sensitive content: any signed-in user may read it.
drop policy if exists "content: read" on public.content_items;
create policy "content: read" on public.content_items
  for select to authenticated using (true);

drop policy if exists "clusters: read" on public.content_clusters;
create policy "clusters: read" on public.content_clusters
  for select to authenticated using (true);

drop policy if exists "sources: read" on public.sources;
create policy "sources: read" on public.sources
  for select to authenticated using (true);

drop policy if exists "pulse: read" on public.pulse_repos;
create policy "pulse: read" on public.pulse_repos
  for select to authenticated using (true);

drop policy if exists "eol: read" on public.eol_cycles;
create policy "eol: read" on public.eol_cycles
  for select to authenticated using (true);
