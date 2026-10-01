# Devlr delivery platform: design

A multi-tenant transactional email API with a durable delivery queue.

Callers hand it a message over HTTP and get an immediate acknowledgement; the
platform owns everything after that: retries, provider failover, suppression,
and the record of what actually happened.

It shares a repo with Devlr but is separate infrastructure. Devlr's own issues
currently go out through a simple mailer (`lib/email/send.ts`), because the
platform needs a long-lived worker process and there is no free host for one.
When Devlr outgrows a single SMTP account, this is what it moves onto.

---

## Why this shape

The problem an email platform actually solves is that **accepting a message and
delivering it have completely different reliability profiles.**

Accepting is a single database write: fast, predictable, entirely under our
control. Delivering depends on a third party that can be slow, rate limited, or
down for hours, and whose failures say nothing about whether the caller's request
was valid.

Coupling them — sending inline in the request handler — means the caller's
latency is the provider's latency, and a provider outage becomes an outage of
your API. So the two are split by a queue, and everything below follows from
that one decision.

```
   client
     │  POST /api/v1/messages          (API key auth, idempotency key)
     ▼
┌─────────────────┐
│  Route handler  │  validate → enqueue_message() → 202
└────────┬────────┘
         │ one transaction
         ▼
┌──────────────────────────────────────────────┐
│  Postgres                                    │
│   platform_messages        (what was asked)  │
│   platform_delivery_jobs   (the queue)       │
│   platform_events          (what happened)   │
│   platform_suppressions    (never send here) │
└────────┬─────────────────────────────────────┘
         │ claim_delivery_jobs()  — FOR UPDATE SKIP LOCKED
         ▼
┌─────────────────┐   ┌─────────────────┐
│    Worker 1     │   │    Worker N     │   long-lived processes,
│  claim→send→ack │   │  claim→send→ack │   coordinating only via the DB
└────────┬────────┘   └────────┬────────┘
         │                     │
         ▼                     ▼
   ┌──────────────────────────────────┐
   │  ProviderPool                    │
   │   smtp → gmail → …  per-provider │
   │   circuit breakers, in order     │
   └──────────────────────────────────┘
```

---

## Decisions worth defending

### Postgres as the queue, not Redis/SQS/Kafka

The messages are already in Postgres. A separate broker would mean a distributed
transaction between "message accepted" and "job enqueued" — or accepting that the
two can diverge, which produces the worst possible bug: an API that returned 202
for a message nothing will ever deliver. In one database they commit together.

`SELECT … FOR UPDATE SKIP LOCKED` provides exactly the semantics a queue needs.
Concurrent workers claim disjoint batches without blocking each other: rows
worker A has locked are *invisible* to worker B's scan rather than something B
waits on. Without `SKIP LOCKED`, a worker pool serialises behind its own locks.

**The honest limit:** every claim is a write, so this tops out in the low
thousands of jobs/second on modest hardware. Past that a dedicated broker starts
to earn its operational cost. Below it, one less moving part is worth more than
headroom nobody is using.

### Leases, not locks

A claimed job is owned until `lease_expires_at`. If a worker dies mid-send, the
lease simply lapses and the job is reclaimed.

The reclaim is folded into the claim query itself — a job is eligible if it is
`pending` and due, **or** `active` with an expired lease — which removes the need
for a separate reaper process. A missed heartbeat self-heals on the next poll.

`attempts` increments at **claim** time, not failure time. A worker that dies
silently must still burn an attempt, or a message that reliably kills its worker
(a payload that triggers an OOM) is retried forever and blocks everything behind
it.

Leases stay short so crash recovery is fast, and long sends are covered by a
**heartbeat** that extends the lease while work is genuinely in flight. Setting a
long lease instead would trade duplicate sends for slow recovery on every job.

### Exponential backoff with full jitter

Consider a provider that goes down for thirty seconds with 5,000 jobs in flight.
Without jitter, every job fails at the same instant, computes the identical
delay, and retries at the same instant — reproducing the thundering herd on a
timer, in lockstep, forever.

Full jitter (`random(0, ceiling)`) decorrelates them so the load arrives smeared
rather than spiked. Chosen over equal jitter because the scarce resource is the
provider's rate limit, not our CPU.

### Circuit breakers per provider

Without one, a provider that is down still receives every message, and each send
waits out its full timeout before failing. Workers spend all their concurrency
sitting on doomed sockets, and the queue stops draining *even for providers that
are healthy*. The breaker converts a slow failure into an instant one, which is
what frees the worker to fail over.

The `half_open` state admits exactly one probe after the cooldown. Flipping
straight from open to closed would release the entire backlog at a provider that
has only just come back up — turning recovery into a second outage.

A `PermanentSendError` deliberately does **not** count against the breaker: a
burst of malformed payloads is a bad-message problem, and letting it take a
healthy provider offline would be the wrong inference.

### Idempotency at the edge

`(tenant_id, idempotency_key)` is a partial unique index. A retried HTTP request
returns the original message with `idempotent_replay: true` and HTTP 200 rather
than 202.

The fast-path `SELECT` is an optimisation, not the guarantee. Two concurrent
requests with the same key can both pass it, so the insert catches
`unique_violation` and resolves to the winner's row — a duplicate suppressed
under concurrency is a *success* from the caller's point of view, not a 500.

### Suppression at accept time

Hard bounces and complaints are checked before a job is created, so a suppressed
address never occupies a queue slot. Continuing to send to a known-dead mailbox
is the fastest way to destroy a sending domain's reputation, and providers treat
repeat offences as evidence of a bad sender rather than a bug.

### Header injection is the security boundary

SMTP separates headers with CRLF, so a subject of `"Hi\r\nBcc: everyone@…"`
becomes a real `Bcc` header on serialisation. That turns a send API into an open
relay for anyone who can reach it. Newlines are rejected — not stripped — in
every field that reaches a header. This is the most-tested path in the codebase.

### API keys are stored hashed, with SHA-256 not bcrypt

The usual advice is inverted here deliberately. Slow hashes exist to frustrate
offline brute force of low-entropy human-chosen passwords. An API key is 256
random bits, so there is nothing to brute force, and a deliberately slow hash
would add latency to every request while buying no security. Fast and
deterministic is also what lets the hash be a unique index.

---

## Failure modes, and what happens

| Failure | Behaviour |
|---|---|
| Worker crashes mid-send | Lease expires, job reclaimed by another worker. May duplicate that one message — the trade for never losing one. |
| Worker receives SIGTERM | Stops claiming, drains in-flight sends within the grace period, exits cleanly. |
| Provider down | Breaker trips after 5 consecutive failures, traffic fails over to the next provider. |
| All providers down | Jobs retry with backoff until `max_attempts`, then dead-letter with the full error chain. |
| Database unreachable | Workers back off and retry the claim; the API returns 503. Nothing is lost. |
| Client retries a request | Idempotency key resolves to the original message. No second send. |
| Caller sends to a bounced address | Rejected at accept time, recorded as `suppressed`. |

**Delivery semantics are at-least-once, not exactly-once.** A worker can send a
message and die before recording the result; the lease lapses and it is sent
again. True exactly-once would require the provider to participate in a
transaction with us, which no email provider offers. The idempotency key bounds
duplicates at the API edge; beyond it, duplication is preferred to loss.

---

## What I would change at 100×

- **Move claims off the primary.** The claim is a write on the hot path. At
  volume, partition `platform_delivery_jobs` by tenant, or shard.
- **Swap in a real broker.** Past a few thousand jobs/second the write
  amplification of a database queue stops being worth the simplicity.
- **Per-tenant fair scheduling.** Today one tenant with a million queued messages
  starves everyone behind them. Weighted round-robin over per-tenant queues.
- **Rollup tables for analytics.** Aggregating raw events is fine at thousands of
  rows and unusable at billions; pre-aggregate into hourly buckets on write.
- **Prune `platform_events`.** It grows without bound. Rollups plus a retention
  window.

---

## Testing

`npm test` — 49 unit tests over the pure logic: backoff and jitter properties,
failure classification, circuit breaker state transitions, provider failover, and
request validation including every header-injection vector.

Deliberately not mocked: the SQL functions are tested by running them, because
their whole purpose is transactional behaviour that a mock cannot exhibit.

### Benchmarking honestly

Load tests run against `SinkProvider` or a local Mailpit, never a real provider.
Benchmarking against SES measures *their* SMTP server, not this queue, and free
tiers cap out long before the queue does. The sink isolates what is actually
under test: claim rate, lock contention, retry behaviour.

Any number reported in this repo is measured with induced worker kills, and says
so. "2,400 sends/min sustained with zero duplicates across 50k sends, killing a
worker every 30s" is a checkable claim. "Handles millions of emails" is not.
