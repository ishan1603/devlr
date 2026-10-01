-- Sendlr Delivery Platform — schema
-- Run in Supabase Dashboard -> SQL Editor. Safe to re-run (idempotent).
--
-- This is the infrastructure layer: a multi-tenant transactional email API with
-- a durable job queue. The newsletter in `schema.sql` becomes one client of it
-- rather than the whole product.
--
-- Everything here is prefixed `platform_` so it can live beside the existing
-- newsletter tables without collision.

-- ===========================================================================
-- platform_tenants — the unit of isolation and rate limiting
-- ===========================================================================

create table if not exists public.platform_tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  -- Per-tenant send ceiling, enforced before a message is accepted. Kept on the
  -- tenant row rather than in config so it can be tuned per customer without a
  -- deploy.
  rate_limit_per_sec integer not null default 10 check (rate_limit_per_sec > 0),
  daily_quota        integer not null default 10000 check (daily_quota > 0),
  created_at  timestamptz not null default now()
);

-- ===========================================================================
-- platform_api_keys
-- ===========================================================================
-- Only a SHA-256 hash of the key is stored. The raw key is shown exactly once,
-- at creation, and is unrecoverable afterwards -- the same contract Stripe and
-- GitHub use. Storing keys in plaintext would mean a read-only leak of this
-- table is a full send-on-your-behalf compromise for every tenant.
--
-- `key_prefix` is the first few characters, kept in the clear purely so a UI can
-- show "sk_live_a1b2..." in a key list without being able to authenticate.

create table if not exists public.platform_api_keys (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.platform_tenants (id) on delete cascade,
  name         text not null default 'default',
  key_prefix   text not null,
  key_hash     text not null unique,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

-- Authentication looks a key up by hash on every request, so this is a hot path.
create index if not exists platform_api_keys_hash_idx on public.platform_api_keys (key_hash);
create index if not exists platform_api_keys_tenant_idx on public.platform_api_keys (tenant_id);

-- ===========================================================================
-- platform_suppressions — addresses we must never send to again
-- ===========================================================================
-- A hard bounce means the mailbox does not exist; a complaint means the
-- recipient pressed "spam". Continuing to send to either is the fastest way to
-- destroy a sending domain's reputation, and mailbox providers treat repeat
-- offences as evidence of a bad sender rather than a bug.
--
-- Checked at accept time, so a suppressed address never occupies a queue slot.

create table if not exists public.platform_suppressions (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.platform_tenants (id) on delete cascade,
  email      text not null,
  reason     text not null check (reason in ('hard_bounce', 'complaint', 'unsubscribe', 'manual')),
  created_at timestamptz not null default now(),
  -- Suppression is per tenant: one customer's bounce is not another's.
  unique (tenant_id, email)
);

create index if not exists platform_suppressions_lookup_idx
  on public.platform_suppressions (tenant_id, email);

-- ===========================================================================
-- platform_messages — the accepted send request
-- ===========================================================================
-- One row per logical message: what the API accepted and what the caller can
-- query. `platform_delivery_jobs` is the separate, mutable record of our
-- attempts to deliver it. Keeping them apart means retry bookkeeping never
-- rewrites the caller's original request.

create table if not exists public.platform_messages (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.platform_tenants (id) on delete cascade,

  -- Caller-supplied idempotency key, scoped to the tenant. A retried HTTP
  -- request (network timeout, client-side retry, double-clicked button) returns
  -- the original message instead of sending a second copy.
  idempotency_key text,

  to_email        text not null,
  from_email      text not null,
  subject         text not null,
  html_body       text,
  text_body       text,

  status          text not null default 'queued'
                    check (status in ('queued', 'sending', 'sent', 'failed', 'suppressed')),

  -- Null means "send now". A future timestamp defers the job.
  scheduled_for   timestamptz,

  provider        text,
  provider_message_id text,
  failure_reason  text,

  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

-- The idempotency guarantee. Partial, so that rows without a key (the caller did
-- not supply one) are not all forced into conflict on a single null value.
create unique index if not exists platform_messages_idempotency_key
  on public.platform_messages (tenant_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists platform_messages_tenant_idx
  on public.platform_messages (tenant_id, created_at desc);
create index if not exists platform_messages_status_idx
  on public.platform_messages (status);

-- ===========================================================================
-- platform_delivery_jobs — the queue
-- ===========================================================================
-- A Postgres-backed work queue rather than Redis/SQS/Kafka. The reasons are
-- deliberate and worth being able to defend:
--
--   * The messages are already in Postgres. A separate broker would mean a
--     distributed transaction between "message accepted" and "job enqueued", or
--     accepting that the two can diverge. Here they commit together.
--   * FOR UPDATE SKIP LOCKED gives exactly the semantics a queue needs:
--     concurrent workers claim disjoint batches without blocking each other.
--   * It is one fewer piece of infrastructure to run, which matters more than
--     peak throughput until peak throughput is actually the problem.
--
-- The honest limit: every claim is a write, so this tops out in the low
-- thousands of jobs per second on modest hardware. Past that, a dedicated broker
-- starts to earn its operational cost.

create table if not exists public.platform_delivery_jobs (
  -- bigserial, not uuid: the queue is scanned in insertion order, and a
  -- monotonic key keeps that index dense rather than scattering inserts across
  -- the btree the way a random uuid does.
  id               bigserial primary key,
  message_id       uuid not null unique references public.platform_messages (id) on delete cascade,

  status           text not null default 'pending'
                     check (status in ('pending', 'active', 'succeeded', 'dead')),

  attempts         integer not null default 0,
  max_attempts     integer not null default 5,

  -- When this job becomes eligible. Pushed forward on retry (backoff), and set
  -- at creation for a scheduled send.
  run_after        timestamptz not null default now(),

  -- Lease-based ownership. A worker claims a job until `lease_expires_at`; if it
  -- dies without reporting back, the lease lapses and the job is reclaimed by
  -- the next claim call. This is what makes worker death a non-event rather than
  -- a permanently stuck message.
  lease_expires_at timestamptz,
  locked_by        text,

  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- The claim query's supporting indexes. Both are partial: most rows end up
-- 'succeeded' and should not be carried in either index.
create index if not exists platform_jobs_pending_idx
  on public.platform_delivery_jobs (run_after, id)
  where status = 'pending';

create index if not exists platform_jobs_expired_lease_idx
  on public.platform_delivery_jobs (lease_expires_at)
  where status = 'active';

create index if not exists platform_jobs_dead_idx
  on public.platform_delivery_jobs (created_at desc)
  where status = 'dead';

-- ===========================================================================
-- platform_events — the delivery event log
-- ===========================================================================
-- Append-only. Provider webhooks (delivered, bounced, complained, opened) land
-- here, as do our own lifecycle transitions, so a message's full history is
-- reconstructable.
--
-- Webhooks are at-least-once and arrive out of order, so consumers must be
-- idempotent: `provider_event_id` is unique, and a duplicate delivery collides
-- on insert instead of double-counting.

create table if not exists public.platform_events (
  id                uuid primary key default gen_random_uuid(),
  message_id        uuid references public.platform_messages (id) on delete cascade,
  tenant_id         uuid not null references public.platform_tenants (id) on delete cascade,
  type              text not null
                      check (type in ('queued', 'suppressed', 'sending', 'sent', 'delivered',
                                      'soft_bounce', 'hard_bounce', 'complaint',
                                      'opened', 'clicked', 'failed', 'dead')),
  provider          text,
  provider_event_id text,
  detail            jsonb,
  -- The provider's timestamp for the event, which is not when we recorded it.
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

create unique index if not exists platform_events_provider_dedupe
  on public.platform_events (provider, provider_event_id)
  where provider_event_id is not null;

create index if not exists platform_events_message_idx
  on public.platform_events (message_id, occurred_at);
create index if not exists platform_events_tenant_time_idx
  on public.platform_events (tenant_id, occurred_at desc);

-- ===========================================================================
-- claim_delivery_jobs — the heart of the queue
-- ===========================================================================
-- Atomically claims up to `p_batch_size` eligible jobs for one worker.
--
-- The inner SELECT takes row locks with SKIP LOCKED, so two workers running this
-- concurrently silently partition the queue between them: rows worker A has
-- locked are invisible to worker B's scan rather than blocking it. Without SKIP
-- LOCKED, worker B would wait on A's locks and the pool would serialise.
--
-- Eligibility is two cases in one pass:
--   1. pending jobs whose run_after has arrived, and
--   2. active jobs whose lease has expired -- a worker crashed mid-send.
--
-- Folding case 2 in here is what removes the need for a separate reaper process:
-- a missed heartbeat self-heals on the next claim.
--
-- `attempts` increments at claim time, not at failure time. A worker that dies
-- silently must still burn an attempt, or a message that reliably kills its
-- worker (a malformed payload that triggers an OOM, say) would be retried
-- forever and block the queue behind it.

create or replace function public.claim_delivery_jobs(
  p_worker_id     text,
  p_batch_size    integer,
  p_lease_seconds integer
)
returns setof public.platform_delivery_jobs
language sql
as $$
  update public.platform_delivery_jobs j
     set status           = 'active',
         locked_by        = p_worker_id,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts         = j.attempts + 1,
         updated_at       = now()
   where j.id in (
     select c.id
       from public.platform_delivery_jobs c
      where (c.status = 'pending' and c.run_after <= now())
         or (c.status = 'active'  and c.lease_expires_at < now())
      order by c.run_after, c.id
      limit p_batch_size
      for update skip locked
   )
  returning j.*;
$$;

-- ===========================================================================
-- enqueue_message — accepting a send, atomically
-- ===========================================================================
-- Accepting a message is three writes that must agree: the message row, its
-- delivery job, and the opening event. The Supabase client cannot span a
-- transaction across separate calls, so doing this from TypeScript would leave a
-- window where a crash produces a message with no job -- a send that the API
-- has acknowledged and that nothing will ever deliver. Inside a function they
-- commit or roll back together.
--
-- Returns `created = false` when the call was a replay of an existing
-- idempotency key, so the API can distinguish 201 from 200.

create or replace function public.enqueue_message(
  p_tenant_id       uuid,
  p_idempotency_key text,
  p_to              text,
  p_from            text,
  p_subject         text,
  p_html            text,
  p_text            text,
  p_scheduled_for   timestamptz
)
returns table (message_id uuid, message_status text, created boolean)
language plpgsql
as $$
declare
  v_existing_id     uuid;
  v_existing_status text;
  v_suppressed      boolean;
  v_id              uuid;
  v_status          text;
begin
  -- Fast path for an obvious replay. This is an optimisation, not the
  -- guarantee -- the unique index and the exception handler below are what make
  -- it correct under concurrency.
  if p_idempotency_key is not null then
    select id, status into v_existing_id, v_existing_status
      from public.platform_messages
     where tenant_id = p_tenant_id
       and idempotency_key = p_idempotency_key;

    if found then
      return query select v_existing_id, v_existing_status, false;
      return;
    end if;
  end if;

  -- Suppression is checked at accept time rather than at send time so a
  -- suppressed address never occupies a queue slot. The caller still gets a
  -- message id back and can see why nothing was sent.
  select exists (
    select 1 from public.platform_suppressions
     where tenant_id = p_tenant_id and email = lower(p_to)
  ) into v_suppressed;

  v_status := case when v_suppressed then 'suppressed' else 'queued' end;

  begin
    insert into public.platform_messages
      (tenant_id, idempotency_key, to_email, from_email, subject,
       html_body, text_body, status, scheduled_for)
    values
      (p_tenant_id, p_idempotency_key, lower(p_to), p_from, p_subject,
       p_html, p_text, v_status, p_scheduled_for)
    returning id into v_id;
  exception when unique_violation then
    -- Two requests carrying the same idempotency key raced past the SELECT
    -- above and both attempted the insert. One won. The loser resolves to the
    -- winner's row rather than surfacing a 500 for what is, from the caller's
    -- point of view, a successful duplicate suppression.
    select id, status into v_existing_id, v_existing_status
      from public.platform_messages
     where tenant_id = p_tenant_id
       and idempotency_key = p_idempotency_key;

    return query select v_existing_id, v_existing_status, false;
    return;
  end;

  if not v_suppressed then
    insert into public.platform_delivery_jobs (message_id, run_after)
    values (v_id, coalesce(p_scheduled_for, now()));
  end if;

  insert into public.platform_events (message_id, tenant_id, type)
  values (v_id, p_tenant_id, v_status);

  return query select v_id, v_status, true;
end;
$$;

-- ===========================================================================
-- complete_delivery_job / fail_delivery_job — reporting an attempt's outcome
-- ===========================================================================
-- Same atomicity argument as enqueue_message: the job's terminal state, the
-- message's user-visible status, and the event log entry are one fact recorded
-- in three places, and a crash between them leaves the system lying about
-- itself. A job marked succeeded whose message still reads 'sending' is
-- indistinguishable from a stuck send.

create or replace function public.complete_delivery_job(
  p_job_id              bigint,
  p_provider            text,
  p_provider_message_id text
)
returns void
language plpgsql
as $$
declare
  v_message_id uuid;
  v_tenant_id  uuid;
begin
  update public.platform_delivery_jobs
     set status           = 'succeeded',
         lease_expires_at = null,
         locked_by        = null,
         last_error       = null,
         updated_at       = now()
   where id = p_job_id
  returning message_id into v_message_id;

  if v_message_id is null then
    -- The job was deleted, or this id never existed. Nothing to record, and
    -- raising here would only poison a worker over a message that is already
    -- gone.
    return;
  end if;

  update public.platform_messages
     set status              = 'sent',
         provider            = p_provider,
         provider_message_id = p_provider_message_id,
         sent_at             = now()
   where id = v_message_id
  returning tenant_id into v_tenant_id;

  insert into public.platform_events (message_id, tenant_id, type, provider, detail)
  values (v_message_id, v_tenant_id, 'sent', p_provider,
          jsonb_build_object('provider_message_id', p_provider_message_id));
end;
$$;

-- `p_permanent` comes from the worker's classification of the failure (a 5xx is
-- worth retrying, a 550 "no such mailbox" is not), and `p_run_after` carries the
-- jittered backoff computed in TypeScript. The retry *policy* lives in
-- lib/platform/backoff.ts where it can be unit tested; this function only
-- applies the decision.

create or replace function public.fail_delivery_job(
  p_job_id    bigint,
  p_error     text,
  p_permanent boolean,
  p_run_after timestamptz
)
returns table (dead boolean)
language plpgsql
as $$
declare
  v_job        public.platform_delivery_jobs;
  v_tenant_id  uuid;
  v_is_dead    boolean;
begin
  select * into v_job from public.platform_delivery_jobs where id = p_job_id;
  if not found then
    return query select false;
    return;
  end if;

  -- `attempts` was already incremented at claim time, so it counts the attempt
  -- that just failed. A permanent failure skips the remaining budget entirely.
  v_is_dead := p_permanent or v_job.attempts >= v_job.max_attempts;

  if v_is_dead then
    update public.platform_delivery_jobs
       set status           = 'dead',
           lease_expires_at = null,
           locked_by        = null,
           last_error       = p_error,
           updated_at       = now()
     where id = p_job_id;

    update public.platform_messages
       set status         = 'failed',
           failure_reason = p_error
     where id = v_job.message_id
    returning tenant_id into v_tenant_id;

    insert into public.platform_events (message_id, tenant_id, type, detail)
    values (v_job.message_id, v_tenant_id, 'dead',
            jsonb_build_object('error', p_error, 'attempts', v_job.attempts,
                               'permanent', p_permanent));
  else
    -- Back to 'pending' rather than staying 'active': the job is no longer
    -- owned by anyone, and leaving it active would make it wait out a lease it
    -- no longer holds before becoming eligible again.
    update public.platform_delivery_jobs
       set status           = 'pending',
           lease_expires_at = null,
           locked_by        = null,
           last_error       = p_error,
           run_after        = p_run_after,
           updated_at       = now()
     where id = p_job_id;

    select tenant_id into v_tenant_id
      from public.platform_messages where id = v_job.message_id;

    insert into public.platform_events (message_id, tenant_id, type, detail)
    values (v_job.message_id, v_tenant_id, 'failed',
            jsonb_build_object('error', p_error, 'attempts', v_job.attempts,
                               'retry_at', p_run_after));
  end if;

  return query select v_is_dead;
end;
$$;

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
-- Every table here is written and read exclusively by the service role: the API
-- authenticates callers by API key, not by a Supabase session, so `auth.uid()`
-- is meaningless in this half of the schema.
--
-- RLS is still enabled on all of them. With RLS on and no policy granting
-- access, the anon key -- which ships in the browser bundle -- can read nothing,
-- while the service role continues to bypass RLS as designed. Leaving RLS off
-- would expose every tenant's API key hashes and message bodies to anyone who
-- read the public key out of the JS bundle.

alter table public.platform_tenants       enable row level security;
alter table public.platform_api_keys      enable row level security;
alter table public.platform_suppressions  enable row level security;
alter table public.platform_messages      enable row level security;
alter table public.platform_delivery_jobs enable row level security;
alter table public.platform_events        enable row level security;
