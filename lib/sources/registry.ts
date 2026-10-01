import type { SourceCategory, SourceDef } from "@/lib/sources/types";

/**
 * Where Devlr reads.
 *
 * Every entry is an official feed or a documented public API. Nothing here is
 * scraped, nothing needs a key, and nothing sits behind a paywall. Adding a
 * source is a one-line diff; `npm run sources:check` fetches every entry and
 * reports the ones that no longer answer.
 *
 * `quality` is the prior: how much to trust an item before anyone has voted on
 * it. Roughly: a project's own blog 0.85+, a respected engineering blog 0.8,
 * general tech press 0.55.
 */

function rss(
  id: string,
  name: string,
  url: string,
  category: SourceCategory,
  topics: string[],
  quality: number
): SourceDef {
  return { id: `rss:${id}`, kind: "rss", name, url, category, topics, quality };
}

const OFFICIAL: SourceDef[] = [
  // Languages and runtimes
  rss("rust-blog", "Rust Blog", "https://blog.rust-lang.org/feed.xml", "official", ["rust", "systems"], 0.9),
  rss("go-blog", "The Go Blog", "https://go.dev/blog/feed.atom", "official", ["go", "backend"], 0.9),
  rss("python-insider", "Python Insider", "https://blog.python.org/feeds/posts/default?alt=rss", "official", ["python"], 0.85),
  rss("nodejs", "Node.js Blog", "https://nodejs.org/en/feed/blog.xml", "official", ["nodejs", "backend"], 0.85),
  rss("typescript", "TypeScript Blog", "https://devblogs.microsoft.com/typescript/feed/", "official", ["typescript"], 0.9),
  rss("dotnet", ".NET Blog", "https://devblogs.microsoft.com/dotnet/feed/", "official", ["csharp", "backend"], 0.8),
  rss("kotlin", "Kotlin Blog", "https://blog.jetbrains.com/kotlin/feed/", "official", ["kotlin"], 0.8),
  rss("swift", "Swift.org", "https://www.swift.org/atom.xml", "official", ["swift", "mobile"], 0.85),
  rss("elixir", "Elixir Blog", "https://elixir-lang.org/atom.xml", "official", ["elixir", "backend"], 0.85),
  rss("deno", "Deno Blog", "https://deno.com/feed", "official", ["deno", "backend"], 0.8),
  rss("bun", "Bun Blog", "https://bun.sh/rss.xml", "official", ["bun", "backend"], 0.8),
  rss("php", "PHP News", "https://www.php.net/feed.atom", "official", ["php", "backend"], 0.75),
  rss("ruby", "Ruby News", "https://www.ruby-lang.org/en/feeds/news.rss", "official", ["ruby", "backend"], 0.8),

  // Frontend
  rss("react", "React Blog", "https://react.dev/rss.xml", "official", ["react", "frontend"], 0.95),
  rss("nextjs", "Next.js Blog", "https://nextjs.org/feed.xml", "official", ["nextjs", "frontend"], 0.9),
  rss("vue", "Vue Blog", "https://blog.vuejs.org/feed.rss", "official", ["vue", "frontend"], 0.85),
  rss("svelte", "Svelte Blog", "https://svelte.dev/blog/rss.xml", "official", ["svelte", "frontend"], 0.85),
  rss("angular", "Angular Blog", "https://blog.angular.dev/feed", "official", ["angular", "frontend"], 0.8),
  rss("astro", "Astro Blog", "https://astro.build/rss.xml", "official", ["astro", "frontend"], 0.8),
  rss("tailwind", "Tailwind CSS Blog", "https://tailwindcss.com/feeds/feed.xml", "official", ["tailwind", "frontend"], 0.8),
  rss("chrome-dev", "Chrome for Developers", "https://developer.chrome.com/static/blog/feed.xml", "official", ["frontend"], 0.85),
  rss("web-dev", "web.dev", "https://web.dev/static/blog/feed.xml", "official", ["frontend"], 0.85),
  rss("webkit", "WebKit Blog", "https://webkit.org/feed/", "official", ["frontend"], 0.85),
  rss("mozilla-hacks", "Mozilla Hacks", "https://hacks.mozilla.org/feed/", "official", ["frontend"], 0.85),

  // Backend frameworks
  rss("django", "Django Weblog", "https://www.djangoproject.com/rss/weblog/", "official", ["django", "python", "backend"], 0.85),
  rss("rails", "Ruby on Rails", "https://rubyonrails.org/feed.xml", "official", ["rails", "ruby", "backend"], 0.85),
  rss("laravel", "Laravel Blog", "https://blog.laravel.com/feed", "official", ["laravel", "php", "backend"], 0.8),
  rss("spring", "Spring Blog", "https://spring.io/blog.atom", "official", ["spring", "java", "backend"], 0.75),

  // Data
  rss("postgres", "PostgreSQL News", "https://www.postgresql.org/news.rss", "official", ["postgres", "data"], 0.8),
  rss("redis", "Redis Blog", "https://redis.io/blog/feed/", "official", ["redis", "backend"], 0.7),
  rss("clickhouse", "ClickHouse Blog", "https://clickhouse.com/rss.xml", "official", ["clickhouse", "data"], 0.8),
  rss("duckdb", "DuckDB Blog", "https://duckdb.org/feed.xml", "official", ["duckdb", "data"], 0.85),
  rss("confluent", "Confluent Blog", "https://www.confluent.io/rss.xml", "official", ["kafka", "data"], 0.7),
  rss("databricks", "Databricks Blog", "https://www.databricks.com/feed", "official", ["spark", "data", "ai"], 0.7),
  rss("dbt", "dbt Developer Blog", "https://docs.getdbt.com/blog/rss.xml", "official", ["data"], 0.75),

  // Cloud and infrastructure
  rss("kubernetes", "Kubernetes Blog", "https://kubernetes.io/feed.xml", "official", ["kubernetes", "devops"], 0.85),
  rss("docker", "Docker Blog", "https://www.docker.com/blog/feed/", "official", ["docker", "devops"], 0.75),
  rss("hashicorp", "HashiCorp Blog", "https://www.hashicorp.com/blog/feed.xml", "official", ["terraform", "devops"], 0.75),
  rss("cncf", "CNCF Blog", "https://www.cncf.io/feed/", "official", ["kubernetes", "devops"], 0.7),
  rss("aws-news", "AWS News Blog", "https://aws.amazon.com/blogs/aws/feed/", "official", ["aws", "devops"], 0.8),
  rss("gcp", "Google Cloud Blog", "https://cloudblog.withgoogle.com/rss/", "official", ["gcp", "devops"], 0.7),
  rss("azure", "Azure Blog", "https://azure.microsoft.com/en-us/blog/feed/", "official", ["azure", "devops"], 0.7),
  rss("vercel", "Vercel Blog", "https://vercel.com/atom", "official", ["vercel", "frontend"], 0.8),
  rss("grafana", "Grafana Labs Blog", "https://grafana.com/blog/index.xml", "official", ["observability", "devops"], 0.7),

  // Tools
  rss("github-blog", "The GitHub Blog", "https://github.blog/feed/", "official", ["git", "tooling"], 0.8),
  rss("github-changelog", "GitHub Changelog", "https://github.blog/changelog/feed/", "official", ["git", "tooling"], 0.7),
  rss("vscode", "VS Code Updates", "https://code.visualstudio.com/feed.xml", "official", ["vscode", "tooling"], 0.8),
  rss("jetbrains", "JetBrains Blog", "https://blog.jetbrains.com/feed/", "official", ["tooling"], 0.65),

  // Mobile
  rss("android", "Android Developers Blog", "https://android-developers.googleblog.com/feeds/posts/default?alt=rss", "official", ["mobile", "kotlin"], 0.8),
  rss("apple-dev", "Apple Developer News", "https://developer.apple.com/news/rss/news.rss", "official", ["mobile", "swift"], 0.8),
  rss("react-native", "React Native Blog", "https://reactnative.dev/blog/rss.xml", "official", ["react-native", "mobile"], 0.85),
  rss("flutter", "Flutter Blog", "https://medium.com/feed/flutter", "official", ["flutter", "mobile"], 0.8),

  // AI
  rss("huggingface", "Hugging Face Blog", "https://huggingface.co/blog/feed.xml", "official", ["huggingface", "ai"], 0.8),
  rss("openai", "OpenAI News", "https://openai.com/news/rss.xml", "official", ["llm", "ai"], 0.8),
  rss("deepmind", "Google DeepMind Blog", "https://deepmind.google/blog/rss.xml", "official", ["ai"], 0.8),
  rss("google-ai", "Google AI Blog", "https://blog.google/technology/ai/rss/", "official", ["ai", "llm"], 0.7),

  // Game development
  rss("godot", "Godot Engine", "https://godotengine.org/rss.xml", "official", ["gamedev"], 0.85),
];

const ENGINEERING: SourceDef[] = [
  rss("cloudflare", "Cloudflare Blog", "https://blog.cloudflare.com/rss/", "engineering", ["cloudflare", "devops", "backend"], 0.9),
  rss("netflix", "Netflix Tech Blog", "https://netflixtechblog.com/feed", "engineering", ["backend", "data"], 0.85),
  rss("stripe", "Stripe Blog", "https://stripe.com/blog/feed.rss", "engineering", ["backend"], 0.8),
  rss("discord", "Discord Blog", "https://discord.com/blog/rss.xml", "engineering", ["backend"], 0.8),
  rss("meta-eng", "Engineering at Meta", "https://engineering.fb.com/feed/", "engineering", ["backend", "systems"], 0.85),
  rss("slack-eng", "Slack Engineering", "https://slack.engineering/feed/", "engineering", ["backend"], 0.8),
  rss("spotify-eng", "Spotify Engineering", "https://engineering.atspotify.com/feed/", "engineering", ["backend", "data"], 0.8),
  rss("dropbox", "Dropbox Tech", "https://dropbox.tech/feed", "engineering", ["backend", "systems"], 0.8),
  rss("airbnb", "Airbnb Tech Blog", "https://medium.com/feed/airbnb-engineering", "engineering", ["backend", "data"], 0.8),
  rss("shopify", "Shopify Engineering", "https://shopify.engineering/blog.atom", "engineering", ["backend", "rails"], 0.8),
  rss("pinterest", "Pinterest Engineering", "https://medium.com/feed/pinterest-engineering", "engineering", ["backend", "data"], 0.75),
  rss("grab", "Grab Tech", "https://engineering.grab.com/feed.xml", "engineering", ["backend", "data"], 0.75),
  rss("github-eng", "GitHub Engineering", "https://github.blog/engineering/feed/", "engineering", ["backend", "tooling"], 0.85),
  rss("fly", "Fly.io Blog", "https://fly.io/blog/feed.xml", "engineering", ["devops", "backend"], 0.85),
  rss("tailscale", "Tailscale Blog", "https://tailscale.com/blog/index.xml", "engineering", ["devops", "systems"], 0.8),
  rss("supabase", "Supabase Blog", "https://supabase.com/rss.xml", "engineering", ["postgres", "backend"], 0.75),
  rss("planetscale", "PlanetScale Blog", "https://planetscale.com/blog/feed.atom", "engineering", ["mysql", "postgres", "data"], 0.8),
  rss("figma", "Figma Engineering", "https://www.figma.com/blog/feed/atom.xml", "engineering", ["frontend", "backend"], 0.8),
  rss("canva", "Canva Engineering", "https://www.canva.dev/blog/engineering/feed.xml", "engineering", ["backend", "frontend"], 0.75),
  rss("aws-architecture", "AWS Architecture Blog", "https://aws.amazon.com/blogs/architecture/feed/", "engineering", ["aws", "backend"], 0.75),
  rss("all-things-distributed", "All Things Distributed", "https://www.allthingsdistributed.com/atom.xml", "engineering", ["backend", "aws"], 0.85),
];

const BLOGS: SourceDef[] = [
  rss("simon-willison", "Simon Willison", "https://simonwillison.net/atom/entries/", "blog", ["llm", "ai", "python"], 0.9),
  rss("jvns", "Julia Evans", "https://jvns.ca/atom.xml", "blog", ["systems", "tooling", "linux"], 0.9),
  rss("danluu", "Dan Luu", "https://danluu.com/atom.xml", "blog", ["systems", "leadership"], 0.9),
  rss("brooker", "Marc Brooker", "https://brooker.co.za/blog/rss.xml", "blog", ["backend", "systems"], 0.9),
  rss("fowler", "Martin Fowler", "https://martinfowler.com/feed.atom", "blog", ["backend", "leadership"], 0.85),
  rss("pragmatic-engineer", "The Pragmatic Engineer", "https://newsletter.pragmaticengineer.com/feed", "blog", ["leadership"], 0.85),
  rss("lethain", "Irrational Exuberance", "https://lethain.com/feeds.xml", "blog", ["leadership"], 0.85),
  rss("bytebytego", "ByteByteGo", "https://blog.bytebytego.com/feed", "blog", ["backend"], 0.75),
  rss("high-scalability", "High Scalability", "https://highscalability.com/rss/", "blog", ["backend"], 0.7),
  rss("overreacted", "overreacted", "https://overreacted.io/rss.xml", "blog", ["react", "frontend"], 0.9),
  rss("josh-comeau", "Josh W. Comeau", "https://www.joshwcomeau.com/rss.xml", "blog", ["frontend"], 0.9),
  rss("css-tricks", "CSS-Tricks", "https://css-tricks.com/feed/", "tutorial", ["frontend"], 0.75),
  rss("smashing", "Smashing Magazine", "https://www.smashingmagazine.com/feed/", "tutorial", ["frontend"], 0.7),
  rss("fasterthanlime", "fasterthanli.me", "https://fasterthanli.me/index.xml", "blog", ["rust", "systems"], 0.9),
  rss("matklad", "matklad", "https://matklad.github.io/feed.xml", "blog", ["rust", "systems"], 0.9),
  rss("without-boats", "Without Boats", "https://without.boats/index.xml", "blog", ["rust"], 0.85),
  rss("eugene-yan", "Eugene Yan", "https://eugeneyan.com/rss/", "blog", ["ai", "llm"], 0.85),
  rss("lilian-weng", "Lil'Log", "https://lilianweng.github.io/index.xml", "blog", ["ai"], 0.9),
  rss("latent-space", "Latent Space", "https://www.latent.space/feed", "blog", ["ai", "llm", "agents"], 0.8),
  rss("raschka", "Ahead of AI", "https://magazine.sebastianraschka.com/feed", "blog", ["ai", "pytorch"], 0.85),
  rss("bair", "Berkeley AI Research", "https://bair.berkeley.edu/blog/feed.xml", "research", ["ai"], 0.85),
];

const NEWS: SourceDef[] = [
  rss("infoq", "InfoQ", "https://feed.infoq.com/", "news", [], 0.7),
  rss("the-new-stack", "The New Stack", "https://thenewstack.io/feed/", "news", ["devops"], 0.65),
  rss("register-software", "The Register: Software", "https://www.theregister.com/software/headlines.atom", "news", [], 0.65),
  rss("register-security", "The Register: Security", "https://www.theregister.com/security/headlines.atom", "news", ["security"], 0.65),
  rss("ars-tech", "Ars Technica", "https://feeds.arstechnica.com/arstechnica/technology-lab", "news", [], 0.6),
  rss("techcrunch-ai", "TechCrunch AI", "https://techcrunch.com/category/artificial-intelligence/feed/", "news", ["ai"], 0.55),
  rss("lwn", "LWN.net", "https://lwn.net/headlines/rss", "news", ["linux", "systems"], 0.8),
  rss("phoronix", "Phoronix", "https://www.phoronix.com/rss.php", "news", ["linux", "systems"], 0.6),
  rss("game-developer", "Game Developer", "https://www.gamedeveloper.com/rss.xml", "news", ["gamedev"], 0.6),
];

const SECURITY: SourceDef[] = [
  rss("bleeping", "BleepingComputer", "https://www.bleepingcomputer.com/feed/", "news", ["security"], 0.7),
  rss("hacker-news-sec", "The Hacker News", "https://feeds.feedburner.com/TheHackersNews", "news", ["security"], 0.6),
  rss("krebs", "Krebs on Security", "https://krebsonsecurity.com/feed/", "blog", ["security"], 0.85),
  rss("portswigger", "PortSwigger Research", "https://portswigger.net/research/rss", "research", ["security", "frontend"], 0.9),
  rss("project-zero", "Google Project Zero", "https://googleprojectzero.blogspot.com/feeds/posts/default?alt=rss", "research", ["security", "systems"], 0.95),
  rss("google-security", "Google Security Blog", "https://security.googleblog.com/feeds/posts/default?alt=rss", "official", ["security"], 0.85),
  rss("github-security", "GitHub Security Lab", "https://github.blog/security/feed/", "official", ["security"], 0.85),
  rss("socket", "Socket Blog", "https://socket.dev/api/blog/feed.atom", "engineering", ["security", "nodejs"], 0.8),
  rss("snyk", "Snyk Blog", "https://snyk.io/blog/feed/", "engineering", ["security"], 0.65),
];

const AGGREGATORS: SourceDef[] = [
  {
    id: "hn:top",
    kind: "hn",
    name: "Hacker News",
    // Stories from the last two days that cleared a points bar. The Algolia API
    // is public and keyless; the bar keeps this to what the community surfaced.
    url: "https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=100",
    siteUrl: "https://news.ycombinator.com",
    category: "aggregator",
    topics: [],
    quality: 0.6,
  },
  {
    id: "lobsters:hottest",
    kind: "lobsters",
    name: "Lobsters",
    url: "https://lobste.rs/hottest.json",
    siteUrl: "https://lobste.rs",
    category: "aggregator",
    topics: [],
    quality: 0.7,
  },
  {
    id: "devto:top",
    kind: "devto",
    name: "DEV Community",
    url: "https://dev.to/api/articles?top=3&per_page=60",
    siteUrl: "https://dev.to",
    category: "tutorial",
    topics: [],
    quality: 0.45,
  },
  {
    id: "hf:daily-papers",
    kind: "hf_papers",
    name: "Hugging Face Daily Papers",
    url: "https://huggingface.co/api/daily_papers?limit=30",
    siteUrl: "https://huggingface.co/papers",
    category: "research",
    topics: ["ai"],
    quality: 0.7,
  },
];

export const SOURCES: SourceDef[] = [
  ...OFFICIAL,
  ...ENGINEERING,
  ...BLOGS,
  ...NEWS,
  ...SECURITY,
  ...AGGREGATORS,
];

export const SOURCE_BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

/**
 * Hosts whose articles are press coverage. Used to classify links that arrive
 * through an aggregator, where the source itself says nothing about the kind.
 */
export const NEWS_HOSTS = new Set([
  "theregister.com", "arstechnica.com", "techcrunch.com", "theverge.com", "wired.com",
  "infoq.com", "thenewstack.io", "bleepingcomputer.com", "thehackernews.com", "zdnet.com",
  "venturebeat.com", "engadget.com", "reuters.com", "bloomberg.com", "nytimes.com", "wsj.com",
  "bbc.com", "bbc.co.uk", "theguardian.com", "cnbc.com", "ft.com", "404media.co", "lwn.net",
  "phoronix.com", "tomshardware.com", "9to5mac.com", "9to5google.com", "macrumors.com",
  "techradar.com", "theinformation.com", "axios.com", "semafor.com", "apnews.com",
]);
