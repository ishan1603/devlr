-- Devlr: Repo Guard
-- Applied by `npm run db:migrate`. Idempotent: every statement can be re-run.
--
-- What is stored, and what is not. For each repository a reader chose to
-- watch: its dependency list (names and versions), what was found wrong with
-- it, and when the reader was told. No source code and no file contents. No
-- GitHub token either: installation tokens last an hour and are minted on
-- demand, so the only credential kept is the installation's id.

-- ===========================================================================
-- github_installations: which GitHub App installations a reader has linked
-- ===========================================================================
-- An installation id arrives in a redirect URL, which anyone can type. A row
-- exists here only after GitHub itself confirmed that the signed-in person can
-- reach that installation, and `github_login` records who that was so access
-- can be checked again before each scan.
--
-- Unique per (user, installation), not per installation: two people in one
-- organisation can each link it, and each sees only the repositories their
-- own GitHub account can read.

create table if not exists public.github_installations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  installation_id bigint not null,
  account_login   text not null,
  account_type    text not null default 'User' check (account_type in ('User', 'Organization')),
  github_login    text not null,
  github_user_id  bigint,
  suspended_at    timestamptz,
  verified_at     timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, installation_id)
);

create index if not exists github_installations_installation_idx
  on public.github_installations (installation_id);

drop trigger if exists github_installations_set_updated_at on public.github_installations;
create trigger github_installations_set_updated_at
  before update on public.github_installations
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- repositories: what a reader is watching, and the state of its last scan
-- ===========================================================================
-- `inventory` is the dependency list from the last time the repo was read. It
-- is what lets a repo that has not changed be re-checked against new
-- advisories every day without touching GitHub again.
--
-- `report` is the last scan as the reader sees it: one entry per package, with
-- its advisories and its fix. It is a snapshot, replaced whole on each scan.
-- What has to survive between scans (when was this first seen, was the reader
-- told) lives in repo_findings.

create table if not exists public.repositories (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  -- Null for a public repository added by URL, which needs no installation.
  installation_id bigint,
  github_id       bigint not null,
  full_name       text not null,
  default_branch  text,
  is_private      boolean not null default false,
  is_archived     boolean not null default false,
  watching        boolean not null default true,
  -- Authorises one thing without a session: reading this repo's grade as a
  -- badge. It reveals a letter and a number, never what is wrong.
  badge_token     uuid not null default gen_random_uuid(),

  scan_status     text not null default 'pending' check (scan_status in ('pending', 'ok', 'failed')),
  scan_error      text,
  scanned_at      timestamptz,
  scanned_ref     text,
  pushed_at       timestamptz,
  -- Set when the repo is added and when a push touches a manifest. Cleared by
  -- a scan that read the files.
  needs_read      boolean not null default true,

  health_score    smallint check (health_score between 0 and 100),
  health_grade    text check (health_grade in ('A', 'B', 'C', 'D', 'F')),
  counts          jsonb not null default '{}',
  stats           jsonb not null default '{}',
  report          jsonb,
  inventory       jsonb,
  runtimes        jsonb,
  notes           jsonb not null default '[]',

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (user_id, github_id),
  -- Unlinking an installation takes its repositories with it. A null
  -- installation_id is not checked, which is what a public repo needs.
  foreign key (user_id, installation_id)
    references public.github_installations (user_id, installation_id) on delete cascade
);

create unique index if not exists repositories_badge_token_key on public.repositories (badge_token);
create index if not exists repositories_due_idx on public.repositories (scanned_at nulls first) where watching;
create index if not exists repositories_github_idx on public.repositories (github_id);
create index if not exists repositories_installation_idx on public.repositories (installation_id);

drop trigger if exists repositories_set_updated_at on public.repositories;
create trigger repositories_set_updated_at
  before update on public.repositories
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- repo_findings: the memory behind "tell me once"
-- ===========================================================================
-- One row per problem per repo, identified by a key that does not change
-- while the problem stays the same (`vulnerability:npm:next:GHSA-...`). The
-- row holds no description: that is in the report. It holds what a snapshot
-- cannot, which is history.
--
-- A reader is told about a finding once. `notified_priority` is how pressing
-- it was at that moment, so that a finding which later becomes urgent (it
-- entered CISA's exploited list, say) counts as news again.

create table if not exists public.repo_findings (
  id            bigint generated always as identity primary key,
  repo_id       uuid not null references public.repositories (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  key           text not null,
  -- The report entry it belongs to: `ecosystem:name`, or its own key.
  group_key     text not null,
  kind          text not null check (kind in ('malicious', 'vulnerability', 'deprecated', 'eol', 'unresolved')),
  priority      text not null check (priority in ('urgent', 'high', 'medium', 'low')),
  status        text not null default 'open' check (status in ('open', 'resolved')),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  resolved_at   timestamptz,
  notified_at   timestamptz,
  notified_priority text check (notified_priority in ('urgent', 'high', 'medium', 'low')),
  unique (repo_id, key)
);

create index if not exists repo_findings_repo_idx on public.repo_findings (repo_id, status);
-- "Who has something they have not been told about" is asked every half hour.
create index if not exists repo_findings_news_idx on public.repo_findings (user_id)
  where status = 'open' and notified_at is null;

-- ===========================================================================
-- Shared caches: public facts, fetched once and reused across every repo
-- ===========================================================================

-- Advisories as normalised from OSV. `modified` is OSV's own timestamp: a copy
-- is reused for as long as OSV reports the same one.
create table if not exists public.guard_advisories (
  id          text primary key,
  modified    text,
  data        jsonb not null,
  fetched_at  timestamptz not null default now()
);

-- Whether an exact package version is deprecated. Asked of deps.dev once and
-- kept, because the answer for a published version rarely changes.
create table if not exists public.guard_package_status (
  key         text primary key,
  deprecated  boolean not null default false,
  reason      text,
  checked_at  timestamptz not null default now()
);

-- Small documents refreshed on a schedule, such as CISA's exploited list.
create table if not exists public.guard_cache (
  key         text primary key,
  data        jsonb not null,
  fetched_at  timestamptz not null default now()
);

-- ===========================================================================
-- Applying a scan
-- ===========================================================================
-- One call, one transaction: the findings table and the repository row always
-- describe the same scan. Done in the database rather than in TypeScript
-- because it is a read-modify-write over many rows, and two scans of one repo
-- (a push arriving during the daily sweep) must not interleave.
--
-- p_findings  [{ key, group_key, kind, priority }]  everything found this time
-- p_state     columns for the repository row
--
-- Returns what changed, and whether anything is now waiting to be sent.

create or replace function public.guard_apply_scan(
  p_repo_id  uuid,
  p_findings jsonb,
  p_state    jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_user     uuid;
  v_keys     text[];
  v_added    integer;
  v_reopened integer;
  v_resolved integer;
  v_pending  integer;
  v_urgent   integer;
begin
  -- The row lock is what serialises concurrent scans of the same repository.
  select user_id into v_user from public.repositories where id = p_repo_id for update;
  if v_user is null then
    raise exception 'repository % does not exist', p_repo_id using errcode = 'P0002';
  end if;

  select coalesce(array_agg(distinct f ->> 'key'), '{}')
    into v_keys
    from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f;

  select count(*) into v_added
    from unnest(v_keys) k
   where not exists (select 1 from public.repo_findings rf where rf.repo_id = p_repo_id and rf.key = k);

  select count(*) into v_reopened
    from public.repo_findings rf
   where rf.repo_id = p_repo_id and rf.status = 'resolved' and rf.key = any (v_keys);

  insert into public.repo_findings as rf (repo_id, user_id, key, group_key, kind, priority)
  select distinct on (f ->> 'key')
         p_repo_id, v_user, f ->> 'key', f ->> 'group_key', f ->> 'kind', f ->> 'priority'
    from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f
   order by f ->> 'key'
  on conflict (repo_id, key) do update set
    group_key    = excluded.group_key,
    kind         = excluded.kind,
    priority     = excluded.priority,
    last_seen_at = now(),
    -- Something that went away and came back is a new occurrence: it gets a
    -- new first-seen date, and the reader is told again.
    first_seen_at     = case when rf.status = 'resolved' then now() else rf.first_seen_at end,
    notified_at       = case when rf.status = 'resolved' then null else rf.notified_at end,
    notified_priority = case when rf.status = 'resolved' then null else rf.notified_priority end,
    resolved_at  = null,
    status       = 'open';

  -- Whatever was open and is not in this scan has been fixed or removed.
  update public.repo_findings
     set status = 'resolved', resolved_at = now()
   where repo_id = p_repo_id and status = 'open' and not (key = any (v_keys));
  get diagnostics v_resolved = row_count;

  update public.repositories set
    scan_status    = 'ok',
    scan_error     = null,
    scanned_at     = now(),
    needs_read     = false,
    scanned_ref    = coalesce(p_state ->> 'scanned_ref', scanned_ref),
    pushed_at      = coalesce((p_state ->> 'pushed_at')::timestamptz, pushed_at),
    full_name      = coalesce(p_state ->> 'full_name', full_name),
    default_branch = coalesce(p_state ->> 'default_branch', default_branch),
    is_private     = coalesce((p_state ->> 'is_private')::boolean, is_private),
    is_archived    = coalesce((p_state ->> 'is_archived')::boolean, is_archived),
    health_score   = (p_state ->> 'health_score')::smallint,
    health_grade   = p_state ->> 'health_grade',
    counts         = coalesce(p_state -> 'counts', '{}'::jsonb),
    stats          = coalesce(p_state -> 'stats', '{}'::jsonb),
    report         = coalesce(p_state -> 'report', '[]'::jsonb),
    notes          = coalesce(p_state -> 'notes', '[]'::jsonb),
    -- Sent only when the files were read again. Otherwise the stored copy stands.
    inventory      = coalesce(p_state -> 'inventory', inventory),
    runtimes       = coalesce(p_state -> 'runtimes', runtimes)
  where id = p_repo_id;

  select count(*) filter (where notified_at is null),
         count(*) filter (where priority = 'urgent'
                            and (notified_at is null or notified_priority is distinct from 'urgent'))
    into v_pending, v_urgent
    from public.repo_findings
   where repo_id = p_repo_id and status = 'open';

  return jsonb_build_object(
    'user_id', v_user,
    'added', v_added, 'reopened', v_reopened, 'resolved', v_resolved,
    'pending', v_pending, 'pending_urgent', v_urgent);
end;
$$;

-- Record that findings were put in front of the reader, at the priority they
-- had when it happened.
create or replace function public.guard_mark_notified(p_ids bigint[])
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.repo_findings
     set notified_at = now(), notified_priority = priority
   where id = any (p_ids) and status = 'open';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Readers with something to be told, and whether any of it cannot wait for
-- their next regular issue. A finding is urgent news if it is urgent now and
-- the reader was not told so: either never told, or told when it was calmer.
create or replace function public.guard_pending_users()
returns table (user_id uuid, pending integer, urgent integer)
language sql stable
set search_path = public
as $$
  select f.user_id,
         count(*) filter (where f.notified_at is null)::integer,
         count(*) filter (where f.priority = 'urgent'
                            and (f.notified_at is null or f.notified_priority is distinct from 'urgent'))::integer
    from public.repo_findings f
    join public.repositories r on r.id = f.repo_id
   where f.status = 'open'
     and r.watching
     and (f.notified_at is null
          or (f.priority = 'urgent' and f.notified_priority is distinct from 'urgent'))
   group by f.user_id;
$$;

-- Retention. Resolved findings are kept for half a year (long enough to answer
-- "when did we fix that"), cache rows until they are stale enough to refetch.
create or replace function public.prune_guard_data()
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_findings integer; v_advisories integer; v_status integer;
begin
  delete from public.repo_findings
   where status = 'resolved' and resolved_at < now() - interval '180 days';
  get diagnostics v_findings = row_count;

  delete from public.guard_advisories where fetched_at < now() - interval '365 days';
  get diagnostics v_advisories = row_count;

  delete from public.guard_package_status where checked_at < now() - interval '60 days';
  get diagnostics v_status = row_count;

  return jsonb_build_object('findings', v_findings, 'advisories', v_advisories, 'package_status', v_status);
end;
$$;

-- These are for background jobs only. Row level security would already stop a
-- signed-in user from changing anything through them; revoking the right to
-- call them at all means that is not the only thing in the way.
revoke all on function public.guard_apply_scan(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.guard_mark_notified(bigint[]) from public, anon, authenticated;
revoke all on function public.guard_pending_users() from public, anon, authenticated;
revoke all on function public.prune_guard_data() from public, anon, authenticated;
grant execute on function public.guard_apply_scan(uuid, jsonb, jsonb) to service_role;
grant execute on function public.guard_mark_notified(bigint[]) to service_role;
grant execute on function public.guard_pending_users() to service_role;
grant execute on function public.prune_guard_data() to service_role;

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
-- A reader can read their own installations, repositories and findings. Every
-- write goes through an API route or a background job using the service role,
-- so that the limits (how many repos, which columns) are enforced in one place.

alter table public.github_installations enable row level security;
alter table public.repositories         enable row level security;
alter table public.repo_findings        enable row level security;
-- No policies at all on the caches: service role only.
alter table public.guard_advisories     enable row level security;
alter table public.guard_package_status enable row level security;
alter table public.guard_cache          enable row level security;

drop policy if exists "own installations: select" on public.github_installations;
create policy "own installations: select" on public.github_installations
  for select using (auth.uid() = user_id);

drop policy if exists "own repositories: select" on public.repositories;
create policy "own repositories: select" on public.repositories
  for select using (auth.uid() = user_id);

drop policy if exists "own findings: select" on public.repo_findings;
create policy "own findings: select" on public.repo_findings
  for select using (auth.uid() = user_id);
