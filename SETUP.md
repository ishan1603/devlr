# Sendlr AI — Local Setup

Every variable the code actually reads lives in `.env.example`. Copy it and fill it in:

```bash
cp .env.example .env.local
```

`.env.local` already exists with all keys present but **empty**. Fill these five groups.

---

## 1. Supabase — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Required. Powers auth + the `user_preferences` table.

1. Create a project at <https://supabase.com/dashboard>.
2. **Project Settings → API Keys**:
   - `NEXT_PUBLIC_SUPABASE_URL` = *Project URL* (`https://xxxx.supabase.co`)
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = the **anon / public** key (newer projects label this
     *publishable*, `sb_publishable_...`). Never the `service_role` / secret key — it is
     `NEXT_PUBLIC_`, so it ships to the browser.
3. **Project Settings → API Keys** again, for `SUPABASE_SERVICE_ROLE_KEY` = the
   **`service_role` / secret** key. This one bypasses RLS and is server-only — never prefix it
   with `NEXT_PUBLIC_`, never commit it. Background jobs need it (see *Architecture* below).
4. **SQL Editor → New query** → paste all of [`supabase/schema.sql`](supabase/schema.sql) → Run.
   Creates `user_preferences`, the `newsletter_sends` idempotency ledger, and the RLS policies.
   Safe to re-run.
5. **Authentication → Sign In / Providers → Email**: turn **off** *Confirm email*.

   The app uses plain `signUp` / `signInWithPassword` ([app/signin/page.tsx](app/signin/page.tsx))
   and has **no `/auth/callback` route**, so a confirmation link has nothing to exchange its
   `?code=` against and sign-up will dead-end. Leave confirmation off until that route exists.

## 2. Groq — `GROQ_API_KEY`

Required for AI generation. Free.

- <https://console.groq.com/keys> → *Create API Key* (`gsk_...`).
- Without it, [lib/groq-client.ts](lib/groq-client.ts#L22) silently falls back to a plain
  title+description list, so newsletters still send — just unwritten by AI.

> **Model pins go stale silently.** The model at
> [lib/groq-client.ts:72](lib/groq-client.ts#L72) is `openai/gpt-oss-20b` (set 2026-09-09, after
> `llama-3.1-8b-instant` started returning 404 — no Llama model is served on the free tier now).
> A dead pin does not raise: the `catch` degrades to the non-AI fallback, so it presents as "the
> AI stopped working." If output ever goes flat, check the pin first:
> `curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"`

## 3. NewsAPI — `NEWS_API_KEY`

Required for real article sourcing.

- <https://newsapi.org/register> → free Developer key.
- **The free tier only allows requests from localhost.** A deployed instance gets HTTP 426 and
  falls back to [lib/fallback-news.ts](lib/fallback-news.ts). Fine for local dev; a paid plan or
  a different source is needed for production.

## 4. Gmail SMTP — `GMAIL_USER`, `GMAIL_APP_PASSWORD`

Required for delivery ([lib/email-nodemailer.ts](lib/email-nodemailer.ts)). This is the one that
throws hard if missing.

1. Enable 2-Step Verification on the Google account.
2. <https://myaccount.google.com/apppasswords> → generate an app password.
3. `GMAIL_USER` = the full address. `GMAIL_APP_PASSWORD` = the 16 characters, **spaces removed**.
   This is *not* your Google account password.

## 5. Inngest — `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`

**Leave both blank for local development.** The dev server needs no keys.

Only needed when deployed: <https://app.inngest.com> → *Manage* → *Event Keys* / *Signing Key*.

## 6. Resend — `RESEND_API_KEY`

Optional, leave blank. It is only read to print a ✓/✗ line in
[app/api/inngest/route.ts](app/api/inngest/route.ts#L17); the email path is Gmail.

---

## Running it

Two terminals, both required — without the second one, no newsletter is ever generated.

```bash
npm install

# Terminal 1
npm run dev

# Terminal 2
npm run dev:inngest
```

The Inngest CLI is pinned as a devDependency rather than run through `npx`, because its
postinstall downloads a ~100 MB Go binary and this project has an `allowScripts` allowlist in
`package.json` that blocks unapproved install scripts. If `dev:inngest` reports *"Inngest CLI
binary not found"*, the download was skipped — run it by hand once:

```bash
npm install-scripts approve inngest-cli
node node_modules/inngest-cli/postinstall.js
```

- App: <http://localhost:3000> (`/` redirects straight to `/dashboard`)
- Inngest dev dashboard: <http://localhost:8288> — watch runs, payloads and step output here

### Smoke test

1. Sign up at `/signin`.
2. Pick categories at `/select`, choose a frequency and send time, save.
3. Dashboard → **Send Now** → watch the run appear at <http://localhost:8288> → check inbox.

> **Do not deploy yet.** RLS is currently disabled on `user_preferences` in the live project, so
> the anon key — which ships to the browser — can read and write every user's row. See the
> "Known issues" note below.

## Architecture

**Two Supabase clients, deliberately.** [`lib/server.ts`](lib/server.ts) is cookie-scoped: it
carries the signed-in user's JWT so RLS resolves `auth.uid()`, and every API route uses it.
[`lib/supabase-admin.ts`](lib/supabase-admin.ts) is service-role and bypasses RLS. Background
jobs have no cookies, so under RLS the cookie client sees nothing and a run would cancel itself
with "preferences not found" — which reads like missing data, not a missing key.

**Recurrence is a cron, not a chain.** [`newsletter-cron.ts`](lib/inngest/functions/newsletter-cron.ts)
polls every 15 minutes, computes who is due in *their own* timezone, and fans out. The previous
design had each run queue its own successor up to 14 days out; one failure ended the series
silently, resuming forked a second chain, and the local dev server forgets queued events on
restart.

**Ingestion is separate from delivery.** [`ingest-articles.ts`](lib/inngest/functions/ingest-articles.ts)
fetches each category once an hour into a shared `articles` pool; a send then *assembles* from
that pool rather than calling NewsAPI itself. Before, cost scaled with users — N subscribers on
"technology" meant N identical fetches and N Groq completions, which exhausts NewsAPI's
100-request free tier at roughly 25 daily users. Now it scales with distinct categories, of which
there are at most 8. Only categories an active subscriber actually selected are fetched.

**Readers never see a story twice.** `newsletter_send_articles` records which articles went into
each send, and assembly excludes anything that user received in the last 30 days. This is the
content-level counterpart to send-level dedupe below.

**Idempotency is two layers.** Every event carries a `dedupeKey` naming the *logical* send
(`recurring:<user>:2026-09-09`). Inngest drops duplicate events on that key before a run starts;
the `unique` index on `newsletter_sends.dedupe_key` is the durable backstop, claimed by an INSERT
before any paid API call. A failed send releases its claim so the slot can be retried rather than
poisoned.

If the run fails, open it in the Inngest dashboard; the failing step names the cause
(`fetch-news`, `generate-summary`, `send-email`).

---

## Supabase auth email setup

Auth emails (password reset, and confirmation if you turn it back on) go through Supabase, not
through the app's own Gmail sender. Out of the box Supabase uses a built-in mailer capped at a
couple of messages per hour that is explicitly not for production, which is why reset emails
appear to vanish.

### 1. Allow localhost to receive auth redirects

**Authentication -> URL Configuration**

- Leave **Site URL** as your production domain.
- Under **Redirect URLs**, add both:
  - `http://localhost:3000/**`
  - `https://<your-production-domain>/**`

Without the localhost entry Supabase silently rewrites any `redirect_to` it does not recognise
back to the Site URL, so a reset link clicked during local development lands on production
instead. Silently, with no error.

### 2. Point Supabase at Gmail

**Authentication -> Emails -> SMTP Settings**, enable custom SMTP:

| Field | Value |
| --- | --- |
| Sender email | the same address as `GMAIL_USER` |
| Sender name | `Sendlr` |
| Host | `smtp.gmail.com` |
| Port | `465` (use `587` if 465 is blocked on your network) |
| Username | the same address as `GMAIL_USER` |
| Password | `GMAIL_APP_PASSWORD` from `.env.local` |

The sender address must match the authenticated Gmail account or one of its verified aliases;
Gmail rejects mail claiming to be from anyone else.

### 3. Raise the email rate limit

**Authentication -> Rate Limits -> "Rate limit for sending emails"**

Easy to miss: Supabase keeps the low built-in cap even after custom SMTP is configured, so reset
emails carry on failing until this is raised. 30 per hour is a reasonable starting point.

### 4. Optionally re-enable confirmation

With `/auth/callback` now in place, **Confirm email** can safely be switched back on in
**Authentication -> Sign In / Providers -> Email**. It was unusable before only because there was
no route to exchange the confirmation code. Leaving it off is still the more convenient choice
for local development.

> **Gmail is a stopgap.** A free Gmail account allows roughly 500 recipients per day across auth
> mail *and* the newsletters themselves. For anything real, move both to a transactional provider
> such as Resend, Postmark or SendGrid.

### `NEXT_PUBLIC_APP_URL`

Unsubscribe links and password-reset redirects are built from this. It must be
`http://localhost:3000` locally and the real domain in production, or readers get links pointing
at the wrong host.
