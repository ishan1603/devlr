# Devlr: product and build plan

Written 2026-10-01. Status as of that date:

| Phase | State |
|---|---|
| 0. Foundation | Done: rename, package updates, schema and migrations, model router with budgets, style guard, design system |
| 1. Dev Digest | Built: ingestion from 121 sources, enrichment, ranking, the editor graph, email template, onboarding, landing page, app. Not yet run against a live database |
| Extras pulled forward | Built: EOL Watch, Dev Pulse, "more like this" feedback, issue archive, personal feed |
| 2. Repo Guard | Next. Includes the repo health score and README badge |
| 3. Learn | Planned |
| 4. Company Radar | Planned |
| 5. Remaining extras | Release Radar, Slack/Discord/Telegram webhooks |

Where the build differs from the plan below, the code is right and this note says so:

- **Embeddings come from Gemini's free tier**, not a Supabase Edge Function. An Edge Function
  needs the Supabase CLI and an access token to deploy, and Gemini also serves as the bulk
  summariser, so one key covers both. Without the key, duplicate detection falls back to title
  matching and relevance to tags.
- **The email template is in the app, not on the delivery platform.** Issues are sent directly
  over SMTP (`lib/email/send.ts`). The platform in `docs/DESIGN.md` is kept as separate
  infrastructure.
- **The hero's background is a 2D canvas, not WebGL.** A hundred lines of projection maths drew
  the same picture as a 25 KB library would have.
- **Cadence is counted in calendar days** in the reader's timezone, not elapsed hours, so a late
  first issue or a manual send cannot shift the regular one.
- **A `/demo` area** renders every signed-in screen with mock data. It was not in the plan; it
  exists so the interface can be reviewed and screenshot-tested with no database.

Devlr turns Sendlr from a general news newsletter into the inbox a developer actually wants:
news and deep dives for their stack, alerts when their dependencies break or get breached, a
daily design question worth thinking about, and a radar on the companies they care about.

---

## 1. Ground rules

These constrain every decision below. If a feature can't meet them, it waits.

1. **$0 to run.** Every service is on a permanent free tier, not a trial. Free-tier limits are
   designed around (section 6), not hoped away.
2. **Facts come from sources, never from the model.** An LLM can rephrase an advisory; it can
   never decide a package is vulnerable, invent a release, or summarise beyond its source text.
3. **Generate once, compose per user.** LLM work scales with content, not with users. This is
   the existing content-pool rule (`lib/newsletter/pool.ts`) applied to every module.
4. **Inbox, not spam.** One scheduled email per user per day at most, text-first, no images, no
   tracking pixels, one-click unsubscribe per module.
5. **Writes like a person.** No em or en dashes, no stock AI phrasing, specific subject lines.
   Enforced in code, not only in the prompt.
6. **Your code never leaves GitHub.** Repo Guard reads dependency manifests only, and nothing
   from a private repo (not even its name) is sent to an LLM.

---

## 2. Modules

### 2.1 Dev Digest (the core)

News first, then blogs and deep dives, filtered to the user's domains and stack.

**Sources (all free, no scraping where an API or feed exists):**

| Source | What it gives | Access |
|---|---|---|
| Curated RSS/Atom registry (~200 feeds) | Official blogs (GitHub, Node, Rust, Go, Python, React, Chrome, AWS, Cloudflare), engineering blogs (Netflix, Uber, Stripe, Discord, Meta), tech press (Ars, The Register, InfoQ, The New Stack, LWN) | Plain HTTP with ETag / If-Modified-Since |
| Hacker News | Dev news and a popularity signal | Algolia HN Search API, no key |
| Lobsters | High-signal discussion, good tags | `/hottest.json`, `/t/<tag>.json` |
| DEV (Forem) | Tutorials by tag | Public API, no key |
| GitHub | Releases, trending-by-search (new repos sorted by stars) | REST, 5,000 req/h with app token |
| arXiv / Hugging Face papers | Research for AI/ML users | Public APIs |

NewsAPI is dropped. Its free tier only answers requests from localhost, so it returns HTTP 426
in production (already noted in `SETUP.md`).

**Pipeline:** ingest, canonicalise, extract main text, embed, tag, cluster, rank, summarise
once, then compose per user (section 5).

**Duplicates and look-alikes**, in increasing cost:
1. Canonical URL (strip `utm_*`, `ref`, AMP and mobile hosts, trailing slashes; resolve HN and
   Lobsters links to the article they point at).
2. Title fingerprint (normalised SimHash) for exact reposts.
3. Embedding similarity (cosine at or above ~0.86 within 72h) puts stories in the same
   **cluster**. The email shows one item per cluster with "Also covered by The Register,
   InfoQ". Per-user "already seen" moves from URL to cluster id, so the same story from a
   different outlet next week stays out too.

**Ranking:** recency decay x source quality x relevance to the user's interests (embedding
similarity plus tag match) x popularity (HN points, Lobsters score, DEV reactions, and "did this
URL trend on HN" as a cross-source signal), then diversity via MMR so one topic can't fill the
issue. Items touching the user's own dependencies get a boost (Repo Guard synergy).

### 2.2 Repo Guard (GitHub)

Connect GitHub, pick repos, get told when a dependency is vulnerable, breached, deprecated or
reaching end of life, with the exact fix.

**Access model:** a GitHub App, not OAuth `repo` scope. The user picks repos on GitHub's own
install screen. Permissions: Contents read, Metadata read. Installation tokens are short-lived,
so we store only the installation id. Sign-in with GitHub (Supabase OAuth, free) is separate and
optional.

**Inventory:** GitHub's dependency-graph SBOM endpoint (SPDX, all ecosystems GitHub supports,
now async: `sbom/generate-report` then `sbom/fetch-report/{uuid}`). Fallback parsers for
`package-lock.json`, `pnpm-lock.yaml`, `requirements.txt`, `pyproject.toml`, `go.mod` when the
dependency graph is off. Runtime versions from `.nvmrc`, `engines`, `.python-version`,
`Dockerfile` `FROM` lines.

**Official sources, and what each answers:**

| Question | Source |
|---|---|
| Is this version vulnerable? Is it a known malicious package? | OSV.dev `querybatch` (aggregates GitHub Advisories, PyPA, RustSec, Go, OpenSSF malicious-packages). Version matching is done by OSV, not by our own semver code. |
| Is it being exploited in the wild? | CISA KEV catalog (JSON) |
| How likely is exploitation? | FIRST EPSS API |
| Is this package or version deprecated? | deps.dev API (npm deprecation, licences, Scorecard), PyPI JSON (yanked) |
| Is the runtime or framework going end of life? | endoflife.date API |
| What changed in the fixed version? | GitHub Releases of the package's source repo |

**Priority** combines severity, KEV, EPSS, direct vs transitive, runtime vs dev, and whether a
fix exists. Malicious packages and KEV-listed or critical runtime vulnerabilities with a fix are
**urgent** and go out alone (batched within 30 minutes, at most one urgent mail per user per
day). Everything else lands in the regular issue.

**Each finding says:** what it is in one plain sentence, why it matters for this repo, the
command to fix it (`npm i next@16.3.8`), and the advisory id linking to the official source. The
plain-language explainer is generated once per advisory and cached, so it costs nothing per user.

**Scans:** on install, on push to the default branch (webhook), and a daily rescan that catches
newly published advisories against unchanged code. Findings are resolved automatically when a
rescan no longer sees them.

Being honest about Dependabot: GitHub already raises vulnerability alerts per repo for free.
Devlr's edge is one prioritised digest across all repos, deprecations and EOL (which Dependabot
does not cover), exploit context (KEV, EPSS), and upgrade notes in plain language.

### 2.3 Learn

A question worth thinking about, matched to the user's domain and level.

**Formats:** system design ("Design a rate limiter that survives a retry storm"), concept
explainers, spot-the-bug snippets, trade-off calls ("Postgres advisory locks or Redis for this
job queue?"), interview-style questions.

**Quality loop (LangGraph):** topic picker, author, reviewer on a *different* model with a
rubric (correctness, completeness, trade-offs stated, no invented numbers), revise up to twice,
deterministic checks, then store as `approved`. Anything scoring below threshold is never sent.
Items are generated ahead of time in a rolling two-week buffer per domain, shared across users,
so send time costs nothing and the token budget is spread across days.

**Email shape:** question, constraints, three hints, and "Reveal the answer" linking to a web
page with the full answer (diagram in Mermaid on the web, ASCII in the email). The next issue
opens with a short recap of the last answer. Related real-world reading is pulled from the
content pool by embedding ("How Discord stores trillions of messages").

**Progress:** no repeats, difficulty follows the user's level and self-ratings, light spaced
repetition, streaks on the dashboard.

### 2.4 Company Radar

Follow companies; get what they shipped, wrote, released and what the news said.

**Company registry:** a seeded list of ~200 tech companies with domain, aliases, GitHub orgs,
blog, changelog, newsroom and status-page feeds. Unknown companies resolve through Wikidata
(free) to an official site, then RSS autodiscovery and a GitHub org search, and the result is
saved for everyone.

**Sources:** company feeds, GitHub org releases, HN mentions (Algolia), GDELT for wider news,
status-page RSS for incidents.

**Relevance filter:** entity disambiguation is the hard part ("Apple" the fruit, "Rust" the
corrosion). Feed items from the company itself pass; news mentions go through an embedding
check, and a small LLM judge only for borderline cases.

**Output** per company: shipped, wrote, in the news, incidents. Summaries are generated once per
company per window and shared across every follower.

### 2.5 More features (suggested)

Ranked by fit and effort. Every one is $0.

**Confirmed in scope** (the first five are built or scheduled; see the status table above)

| Feature | Why developers would love it | Built on |
|---|---|---|
| **Release Radar** | Follow tools (Next.js, Postgres, Kubernetes), auto-follow your dependencies and your GitHub stars. Release notes summarised with breaking changes called out. | GitHub Releases, Repo Guard inventory |
| **EOL Watch** | "Node 20 reaches end of life in 30 days; 3 of your repos run it." | endoflife.date, runtime detection |
| **Repo health score + README badge** | One number per repo, and a badge that spreads Devlr every time someone reads a README. | Repo Guard findings |
| **View in browser, archive, personal RSS feed** | Every issue gets a page; developers like RSS. | Existing render path |
| **Slack, Discord, Telegram webhooks** | Urgent alerts straight into a team channel. | Webhook URLs the user pastes |
| **More like this / less like this** | Two links per item that tune ranking weights. | Feedback table, ranking |
| **Dev Pulse** | Weekly trending repos per language. | GitHub search API |

**Later**

- Opt-in upgrade PRs for deprecations and EOL (needs Contents write; overlaps Dependabot for
  plain version bumps, so only where Devlr adds something).
- Conference and CFP digest (confs.tech open data).
- HN "Who is hiring" matched to the user's stack.
- `npx devlr scan` for people who won't connect GitHub: sends only the package list.
- Ask Devlr: questions over your own archive.
- Team workspaces for org-level GitHub installs.
- Interview-prep mode in Learn (30-day plan).

---

## 3. Onboarding

One flow, each step saved so leaving midway resumes there.

1. **Sign up**: GitHub, magic link, or password.
2. **What do you build?** Domains (pick 1 to 4): Frontend, Backend, Full-stack web, Mobile,
   Cloud and DevOps, Data engineering, AI and ML, Security, Systems and performance, Game dev,
   Dev tools and open source, Engineering leadership. Plus level, which sets Learn difficulty
   and digest depth.
3. **Your stack**: language, framework, database and cloud chips with autocomplete. Pre-filled
   from GitHub when connected ("Connect GitHub to detect this for you").
4. **Pick modules**: Digest (on by default), Repo Guard, Learn, Company Radar. Each card shows an
   animated preview of the email it produces.
5. **Set up what you picked**: repo picker (GitHub install), company search, Learn track.
6. **Rhythm**: cadence, time, timezone (auto-detected), urgent alerts on or off.
7. **Preview**: your first issue rendered in the browser, with "Send it to me now".

---

## 4. Email system

**Bundling.** Modules have their own cadence, but everything due on the same day goes out as
one Devlr issue, in this order: Security, Releases and EOL, Digest, Company Radar, Learn. Urgent
alerts are the only exception. If there is nothing worth sending, the send is skipped (current
behaviour) rather than padded.

**Design: developer, but inbox-safe.**
- Light baseline with a dark-mode `prefers-color-scheme` enhancement (Apple Mail, Outlook for
  Mac); Gmail's own inversion is tested, not assumed.
- A slim dark masthead with a terminal line (`$ devlr weekly --for ishan`), section labels like
  `// security`, system monospace stack for code (`ui-monospace, SFMono-Regular, Menlo,
  Consolas`), severity as coloured text pills, copyable fix commands in code blocks, ASCII
  diagrams for Learn.
- Tables and inline styles, 600px, no images, no web fonts, a real `text/plain` part, no open
  or click tracking.
- Templates move to **React Email** (MIT, free). Five modules plus bundles, alerts and
  transactional mail is too many hand-written template strings. Rendering from structured data
  stays the rule: the model never emits HTML.

**Deliverability** keeps everything already in place (RFC 8058 one-click unsubscribe,
`Precedence: bulk`, GET-safe unsubscribe) and adds per-module unsubscribe tokens. Tested locally
with Mailpit and scored on mail-tester.com before every template change ships.

**Writing.** One style guard in `lib/ai/style.ts` runs on every model output and subject line:
- Em and en dashes are rewritten, and a draft still containing one fails.
- A banned-phrase list ("delve", "landscape", "game-changer", "seamless", "unleash",
  "it's worth noting", "in today's fast-paced world", "let's dive in", and more).
- Subjects: 60 characters at most, specific, no exclamation marks, no emoji, no shouting, no
  spam-trigger words. Written from the lead item: "lodash in 3 of your repos has a fix waiting",
  "Postgres 18 ships async I/O, plus how Discord stores messages".
- Variety: the user's last few intros are passed in as "don't open like these".
- Summaries are grounded in the article's own extracted text, never the title alone.

---

## 5. Architecture

### 5.1 Stack, all free

| Concern | Choice | Free-tier ceiling that matters |
|---|---|---|
| Web app | Next.js 16 on Vercel Hobby | Vercel's own crons are daily-only on Hobby, so scheduling stays in Inngest |
| Database, auth | Supabase free + pgvector | 500 MB database; project pauses after 7 idle days (the cron keeps it awake) |
| Embeddings | Supabase Edge Function running built-in `gte-small` (384-dim) | Edge function invocation quota; fallback Gemini embeddings free tier |
| Jobs, crons | Inngest Hobby | ~100k executions/month |
| Agents | LangGraph.js (`@langchain/langgraph` 1.x) | n/a |
| LLMs | Groq (`gpt-oss-120b`, `gpt-oss-20b`), Gemini Flash-Lite as fallback | Groq `gpt-oss-120b`: 1,000 requests and 200k tokens per day |
| Email | Gmail SMTP (current) | ~500 recipients/day |
| GitHub | GitHub App | 5,000 requests/hour per installation |
| Overflow crons | GitHub Actions scheduled workflows | Free for public repos, 2,000 min/month private |

**Why LangGraph.js and not CrewAI or AutoGen:** both are Python-only, which would mean a
second service and somewhere free to host it. LangGraph runs in the same TypeScript codebase.

**How agents and Inngest fit together:** Inngest is the durable outer loop (crons, fan-out,
retries); each LangGraph graph runs inside an Inngest step. Every LLM call goes through a cache
keyed by prompt hash, so when a step retries, completed calls replay for free. That gives
durability without a LangGraph checkpointer.

**Graphs, and where the model is actually needed:**

| Graph | Deterministic | LLM |
|---|---|---|
| Digest | Retrieve, rank, diversify, render | Editor: lead pick, intro, subject, "why this matters to you" |
| Repo Guard | Scan, match (OSV), prioritise, render | Advisory explainer, cached per advisory |
| Learn | Topic pick, checks, scheduling | Author, reviewer, reviser |
| Company Radar | Gather, cluster, render | Relevance judge (borderline only), per-company summary |

### 5.2 LLM router

The Groq, Gemini, Cerebras and OpenRouter endpoints are all OpenAI-compatible, so one `openai`
client with a per-provider base URL replaces `groq-sdk`. The router gives:
- fallback order per task, with Zod validation and a retry on bad JSON
- a daily token and request budget per provider stored in Postgres, so we stop before the free
  tier stops us
- deterministic fallbacks: if every provider is exhausted, the digest still sends with source
  descriptions and a templated intro (today's behaviour)
- a privacy rule: user identifiers and private repo names are never sent; prompts use
  placeholders and the renderer fills them in

**Daily budget, roughly:** item summaries (~300/day) on `gpt-oss-20b` or Flash-Lite;
`gpt-oss-120b` reserved for Learn authoring and per-user editor calls (one small call per send).
That supports on the order of 1,000 personalised sends a day before falling back to templated
intros, which is above the email ceiling anyway.

### 5.3 Capacity, honestly

Email is the binding limit. Gmail SMTP allows about 500 recipients a day. With one-per-day
bundling, that is roughly 300 daily readers plus 1,000 weekly readers. Growing past that needs
one thing that costs money: a domain (about $10 a year) so Brevo (300/day free) and Resend
(100/day free) can be stacked behind Gmail in the provider pool that already exists in
`lib/platform/providers.ts`. Everything else stays at $0.

Inngest: the scheduler moves from every 15 minutes to every 30 (send times on the half hour),
ingestion runs every 2 hours in batched steps. Estimated well under 100k executions/month at a
few hundred users. If it gets close, ingestion moves to a GitHub Actions cron.

Database: content is pruned after 60 days (seen-history keeps cluster ids and URLs forever,
which are tiny), extracted text is dropped once summarised, embeddings stored as `halfvec`.
Repo inventories use integer-keyed `package_versions` rather than repeating names per repo.

### 5.4 Data model

Moves from one idempotent `schema.sql` to `supabase/migrations/` with the Supabase CLI (free),
and generated TypeScript types. RLS on every user table; jobs keep using the service-role client
(`lib/supabase-admin.ts`), as today.

**People and preferences**
- `profiles`: user_id, email, display_name, level, timezone, onboarding_step, onboarded_at,
  unsubscribe_token, paused
- `topics`: catalog of domains, languages, frameworks, tools (slug, kind, parent, keywords)
- `user_topics`: user_id, topic_id, weight
- `subscriptions`: user_id, module (`digest`, `repo_guard`, `learn`, `company_radar`,
  `release_radar`), is_active, frequency, custom_interval_days, send_time, last_sent_at,
  settings jsonb, unsubscribe_token. Unique (user_id, module). The cron's `isDue` runs per row.
- `channels`: user_id, kind (`email`, `slack`, `discord`, `telegram`), target, verified

**Content**
- `sources`: kind, url, name, quality_weight, topics, company_id, etag, last_modified,
  last_fetched_at, error_count, is_active
- `content_items`: canonical_url (unique), url, title, description, source_id, published_at,
  kind (`news`, `blog`, `release`, `paper`, `discussion`), tags, company_ids, popularity jsonb,
  embedding halfvec(384), cluster_id, summary, summary_model
- `content_clusters`: representative_item_id, centroid, first_seen_at, item_count

**Delivery** (generalises today's `newsletter_sends` and `newsletter_send_articles`)
- `deliveries`: user_id, dedupe_key (unique), modules, kind, status, subject, item_count,
  web_token, error, run_id, sent_at
- `delivery_items`: delivery_id, user_id, item_type, ref_id, cluster_id, canonical_url
- `feedback`: user_id, item ref, signal

**Repo Guard**
- `github_installations`: installation_id, user_id, account_login, account_type, suspended_at
- `repositories`: user_id, installation_id, github_repo_id, full_name, private, is_monitored,
  last_scanned_sha, last_scanned_at, scan_status
- `package_versions`: int id, ecosystem, name, version
- `repo_packages`: repo_id, package_version_id, is_direct, scope
- `packages`: ecosystem, name, latest_version, deprecated, deprecated_message, source_repo,
  checked_at (shared cache)
- `advisories`: OSV id, aliases, severity, cvss, kev, epss, fixed_versions, summary,
  explainer (generated once), references, published_at, withdrawn_at
- `repo_findings`: repo_id, kind (`vulnerability`, `malicious`, `deprecated`, `eol`,
  `major_behind`), package_version_id, advisory_id, priority, status (`open`, `notified`,
  `resolved`, `ignored`), first_seen_at, notified_at, resolved_at. Unique per repo, kind,
  package and advisory, which is what makes "only tell me once" hold.
- `runtime_lifecycles`: endoflife.date cache

**Learn**
- `learn_topics`: curated bank (domain, title, format, difficulty)
- `learn_items`: topic_id, question, constraints, hints, answer_md, diagram_ascii,
  diagram_mermaid, references, review_score, status, model
- `learn_progress`: user_id, item_id, sent_at, revealed_at, self_rating

**Company Radar**
- `companies`: slug, name, domain, aliases, github_orgs, verified
- `user_companies`: user_id, company_id

**Platform**
- `llm_calls`: prompt_hash, provider, model, tokens, output (doubles as the replay cache)
- `provider_budgets`: provider, day, requests, tokens

The delivery-platform tables (`platform_*`, `docs/DESIGN.md`) are untouched.

---

## 6. Web app

**Direction:** dark-first, terminal-meets-editorial. Geist Sans and Geist Mono (free on Google
Fonts), near-black background with a faint dot grid, one bright accent (a phosphor lime that
darkens for contrast in light mode), severity colours reserved for security. Light mode stays
fully supported. The token rule stays: no hex outside `globals.css`.

**3D hero, kept light:** a CSS 3D stack of floating cards (digest, security alert, Learn
question, company update) that tilts with the pointer. Costs no JavaScript beyond a pointer
handler. Behind it, an optional "dependency constellation" in WebGL using OGL (~25 KB gzipped,
versus ~150 KB for three.js), mounted only when the browser is idle and the hero is visible,
paused off-screen, and skipped for `prefers-reduced-motion`, Save-Data, and small screens.

**Animation:** Motion (`motion/react` with `LazyMotion`) for onboarding steps and
micro-interactions, CSS scroll-driven animations as progressive enhancement, View Transitions
for route changes. Everything honours reduced motion.

**Budgets:** landing LCP under 2s on mid-range mobile over 4G, under 120 KB gzipped JS on the
landing page, CLS under 0.05, Lighthouse mobile 95+ for performance and accessibility.

**Pages**
- Public: `/` landing, `/learn/[slug]` shareable question pages, `/issue/[token]` view in
  browser, `/badge/[repo].svg`, `/privacy`, `/signin`, `/unsubscribe`
- App: `/onboarding`, `/app` home (next sends, repo health, streak), `/app/digest`,
  `/app/repos` and `/app/repos/[id]`, `/app/learn`, `/app/companies`, `/app/issues` archive,
  `/app/settings` (schedule, channels, export, delete account)
- Sidebar on desktop, bottom tab bar on mobile, command palette (`cmdk`) on Cmd/Ctrl+K.

---

## 7. Rename to Devlr

- `package.json` name, metadata, wordmark, all UI copy, email templates, `User-Agent`
  (`Devlr/1.0 (+https://devlr.vercel.app)`), README, SETUP, DESIGN, schema comments, tests,
  `.env.example`. 27 references across 17 files today.
- Inngest app id `sendlr-ai` becomes `devlr`. This registers a new app in the Inngest
  dashboard; the old one can be archived.
- Supabase SMTP sender name, project display name.
- GitHub: `ishan1603/Sendlr-ai` becomes `ishan1603/devlr` via `gh repo rename`. GitHub redirects
  the old URL; the local remote gets updated.
- Vercel project and `devlr.vercel.app` if available.
- The local folder name is better renamed by hand with VS Code closed (OneDrive path, and my
  memory for this project is keyed to it; I'll migrate it).

## 8. Package updates

- Patch and minor now: Next 16.3.8, React 19.3, supabase-js 2.117, nodemailer 10.0.13, tsx,
  types.
- Majors, each checked against its migration guide first: Inngest 3 to 4, ESLint 9 to 10 (needs
  `eslint-config-next` support). TypeScript 7 (the native compiler) waits until Next 16 supports
  it officially.
- Added: `@langchain/langgraph`, `openai` (provider-agnostic client), `zod`, `@react-email/*`,
  `octokit`, a feed parser, `@mozilla/readability` with `linkedom`, `motion`, `ogl`, `cmdk`,
  `lucide-react`.
- Removed: `groq-sdk` (replaced by the router), NewsAPI code and `lib/fallback-news.ts`.

---

## 9. Roadmap

Each phase ships something usable on its own.

| Phase | Scope | Done when |
|---|---|---|
| **0. Foundation** | Checkpoint commit, rename, package updates, migrations setup, new schema core, LLM router with budgets and style guard, new tokens and fonts | App runs as Devlr, tests green, style guard has tests |
| **1. Dev Digest** | Source registry and ingestion, embeddings and clusters, ranking, digest graph, React Email templates, onboarding, landing with 3D hero, app shell | A new user signs up, onboards, and receives a digest with no duplicate or near-duplicate stories |
| **2. Repo Guard** | GitHub App, repo picker, SBOM scan, OSV/KEV/EPSS/deps.dev/endoflife checks, findings, urgent alerts, repos pages, badge | A repo with a known-vulnerable dependency produces exactly one correct alert with a working fix command |
| **3. Learn** | Question bank, author and reviewer graph, two-week buffer, Learn email, reveal pages, progress | Two weeks of reviewed questions per domain exist before the first send |
| **4. Company Radar** | Company registry and resolution, sources, relevance filter, per-company summaries | Following five companies gives a week of accurate, disambiguated updates |
| **5. Extras** | Release Radar, EOL Watch, webhooks, archive and RSS, feedback-driven ranking, Dev Pulse | Picked from section 2.5 by usage |

## 10. Risks

| Risk | Mitigation |
|---|---|
| Gmail SMTP cap and bulk mail from a personal account | Daily bundling, skip empty issues, provider pool ready for a domain when needed |
| Free LLM tiers shrink without notice (Groq already dropped Llama) | Multi-provider router, budgets, deterministic fallbacks, model pins checked at startup |
| Wrong security information | Facts only from OSV and official sources; advisory id and link on every finding; LLM only rephrases |
| Source terms of use | Official feeds and APIs first, honest User-Agent, ETag caching, no Reddit, no paywall bypass |
| 500 MB database | Retention job, halfvec, integer-keyed inventories, size check in the daily cron |
| Inngest execution quota | Batched steps, 30-minute scheduler, GitHub Actions as overflow |
| Vercel Hobby is for non-commercial use | Fine while Devlr is free; revisit before charging anyone |
