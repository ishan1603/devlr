# Devlr: setup

Everything Devlr needs is on a permanent free tier. This takes about fifteen minutes.

```bash
npm install
cp .env.example .env.local
```

If you only want to look at the interface, skip all of this: run `npm run dev` and open
<http://localhost:3000/demo>. Every screen is there with made-up data, no database required.

---

## 1. Supabase: database and sign-in

1. Create a project at <https://supabase.com/dashboard> (name it `devlr`).
2. **Project Settings -> API Keys**, into `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`: the project URL (`https://xxxx.supabase.co`)
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`: the **anon / publishable** key
   - `SUPABASE_SERVICE_ROLE_KEY`: the **service_role / secret** key. It bypasses row level
     security, so it is server-only. Never give it a `NEXT_PUBLIC_` prefix.
3. **Connect -> Session pooler -> URI**, into `SUPABASE_DB_URL`. Replace `[YOUR-PASSWORD]` with
   the database password you chose when creating the project.
4. Create the schema:

   ```bash
   npm run db:migrate
   ```

   This applies every file in [`supabase/migrations`](supabase/migrations) in order and
   records what it ran. It is safe to run again; `npm run db:status` shows what is applied. If
   you would rather not put the connection string on your machine, paste the two files into the
   SQL editor in order instead.

5. **Authentication -> URL Configuration**:
   - **Site URL**: your production URL (for example `https://devlr.vercel.app`)
   - **Redirect URLs**: add `http://localhost:3000/**` and `https://<your-domain>/**`

   Without the localhost entry Supabase silently rewrites any redirect it does not recognise
   back to the Site URL, so a confirmation link clicked during local development lands on
   production. Silently, with no error.

6. **Authentication -> Sign In / Providers -> Email**: for local development, turn **Confirm
   email** off so sign-up works straight away. In production leave it on; `/auth/callback`
   handles the link.

### Sign in with GitHub (optional)

1. GitHub -> Settings -> Developer settings -> **OAuth Apps** -> New. Callback URL:
   `https://<your-project-ref>.supabase.co/auth/v1/callback`.
2. Supabase -> **Authentication -> Sign In / Providers -> GitHub**: paste the client ID and
   secret, enable.

Until this is done the "Continue with GitHub" button says so and email sign-in keeps working.

### Auth emails

Password resets and confirmations are sent by Supabase, not by the app. Its built-in mailer
allows a couple of messages an hour, so for anything real:

1. **Authentication -> Emails -> SMTP Settings**: enable custom SMTP with host `smtp.gmail.com`,
   port `465`, and the same address and app password as `GMAIL_USER` / `GMAIL_APP_PASSWORD`.
2. **Authentication -> Rate Limits**: raise "Rate limit for sending emails". Supabase keeps the
   low built-in cap even after custom SMTP is configured, which is easy to miss.

---

## 2. Language models

| Variable | Get it at | What it does |
|---|---|---|
| `GROQ_API_KEY` | <https://console.groq.com/keys> | Writes subject lines, intros and summaries |
| `GEMINI_API_KEY` | <https://aistudio.google.com/apikey> | Embeddings and most of the summarising |

Both are free and need no card. Set at least Groq. Gemini is strongly recommended: without it
there are no embeddings, so duplicate detection falls back to matching titles and relevance
falls back to tags. Devlr still works; it is just less sharp.

With no keys at all, issues still send. Summaries use each article's own description and the
subject comes from a template.

```bash
npm run ai:check
```

Run that after setting keys, and again whenever summaries start looking flat. Free tiers retire
models without notice, and because the router falls back quietly, a dead model pin shows up as
"the writing got worse", not as an error. This command says exactly which pins are alive.

---

## 3. Email

`GMAIL_USER` and `GMAIL_APP_PASSWORD`:

1. Turn on 2-Step Verification for the Google account.
2. <https://myaccount.google.com/apppasswords> -> create an app password.
3. `GMAIL_USER` is the full address. `GMAIL_APP_PASSWORD` is the 16 characters with the spaces
   removed. It is not your Google password.

Gmail allows roughly 500 recipients a day. That is the real ceiling on how many readers a free
Devlr can have: about 300 daily readers plus 1,000 weekly ones, because everything due on a day
is bundled into one email. Past that you need a domain (about $10 a year, the only cost in the
whole stack) and a provider such as Brevo or Resend, configured through the `SMTP_*` variables.
Those are tried before Gmail.

---

## 4. The rest of `.env.local`

- `NEXT_PUBLIC_APP_URL`: `http://localhost:3000` locally, your real URL in production. Every
  link in an email is built from it.
- `APP_SECRET`: any long random string (`openssl rand -hex 32`). It signs the feedback links.
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`: leave blank locally.
- `GITHUB_TOKEN`: optional. A fine-grained token with no permissions raises the GitHub search
  limit Dev Pulse uses.

---

## 5. Run it

Two terminals, both required. The second one runs the background jobs; without it nothing is
ingested and nothing is sent.

```bash
npm run dev            # terminal 1: the app, http://localhost:3000
npm run dev:inngest    # terminal 2: jobs, dashboard at http://localhost:8288
```

A new install has an empty content pool. Fill it now instead of waiting for the crons:

```bash
npm run jobs:kick
```

Watch the runs at <http://localhost:8288>. Ingest takes under a minute; enriching (embeddings,
clustering, summaries) is paced to stay inside the free model tiers and takes a few minutes.

### Smoke test

1. Sign up at `/signin`.
2. Go through onboarding. The last step previews your first issue.
3. Click **Send it to me now**, watch the `delivery-send` run in the Inngest dashboard, and
   check your inbox.

If a run fails, open it in the dashboard: the failing step names the cause.

### See an issue without a database

```bash
npm run email:preview
npm run email:preview -- --domains backend,ai --stack python,postgres,llm
```

Runs the real fetchers, ranking, summariser and editor against live sources and writes
`.preview/issue.html`. Add `--no-ai` to see the template fallback.

---

## 6. Deploy

The repo is connected to a Vercel project. In **Project Settings -> Environment Variables**, set
everything from `.env.local` except `SUPABASE_DB_URL`, with `NEXT_PUBLIC_APP_URL` set to the
production URL.

Background jobs in production run on Inngest Cloud (free):

1. Create an account at <https://app.inngest.com> and add the Vercel integration, or copy the
   Event Key and Signing Key into Vercel as `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`.
2. Sync the app: Inngest -> Apps -> Sync, with `https://<your-domain>/api/inngest`.

The jobs then run on their own schedule: ingest every two hours, the scheduler every thirty
minutes.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | The app |
| `npm run dev:inngest` | The background job runner |
| `npm run jobs:kick` | Run ingest, EOL and Dev Pulse now |
| `npm run db:migrate` / `db:status` | Apply or list migrations |
| `npm test` | 293 tests, including the migrations against a real Postgres (in-process) |
| `npm run typecheck` / `npm run lint` | Static checks |
| `npm run ai:check` | Which model pins and keys work |
| `npm run sources:check` | Fetch every source once and report dead feeds |
| `npm run email:preview` | Build a real issue from live sources, no database |
| `node scripts/check-responsive.mjs <url>` | Screenshot every screen at four widths and fail on overflow |
| `node scripts/page-weight.mjs <url> <path>` | Gzipped HTML, CSS and JavaScript a page needs for first load |

## How it fits together

**Two Supabase clients, deliberately.** [`lib/server.ts`](lib/server.ts) is cookie-scoped: it
carries the signed-in user's JWT, so row level security applies, and every page and API route
uses it. [`lib/supabase-admin.ts`](lib/supabase-admin.ts) uses the service role and bypasses
it. Background jobs have no cookies, so with the first client they would see nothing and report
"profile not found", which reads like missing data rather than a missing key.

**Content is ingested once and shared.** Sources are fetched into a pool, each article is
embedded, clustered and summarised exactly once, and every reader's issue is assembled from
that pool. Model cost grows with the number of articles, not the number of readers.

**Recurrence is a poll, not a chain.** Every thirty minutes the scheduler works out who is due,
in their own timezone. Nothing is queued for the future, so a missed tick heals itself and
pausing needs nothing cancelled.

**Sends are idempotent twice over.** Each send carries a key naming the logical email
(`scheduled:<user>:2026-10-01`). Inngest drops duplicate events on that key, and a unique index
on `deliveries.dedupe_key` is the durable backstop, claimed by an INSERT before any work is
done. A failed send releases its claim so the next tick can retry.

The product plan and roadmap are in [`docs/DEVLR_PLAN.md`](docs/DEVLR_PLAN.md). The email
delivery platform (the worker and `/api/v1`) is documented in [`docs/DESIGN.md`](docs/DESIGN.md).
