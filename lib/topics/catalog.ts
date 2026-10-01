/**
 * The vocabulary of the whole product.
 *
 * One list drives onboarding (what a user can pick), tagging (what an article
 * can be about), EOL Watch (which lifecycle to follow) and Dev Pulse (which
 * GitHub language to query). Keeping them in one place is what stops a user
 * from selecting an interest nothing is ever tagged with.
 *
 * Slugs are stored in the database, so they are permanent. Names are free to
 * change.
 */

export interface Domain {
  slug: string;
  name: string;
  blurb: string;
  /** Words that, in a title or description, signal this domain. */
  keywords: string[];
}

export type StackKind = "language" | "framework" | "runtime" | "database" | "cloud" | "tool" | "ai";

export interface StackItem {
  slug: string;
  name: string;
  kind: StackKind;
  /** Domains this belongs to. An article tagged with the item inherits them. */
  domains: string[];
  /**
   * Strings that identify the item in running text. Matched on word
   * boundaries, case-insensitively unless `caseSensitive` is set.
   */
  aliases: string[];
  /**
   * For names that are also ordinary words. "Go" and "Rust" would otherwise
   * match half the internet, so they must appear capitalised.
   */
  caseSensitive?: boolean;
  /** Product slug on endoflife.date, when its lifecycle is tracked there. */
  eol?: string;
  /** Language name as GitHub search spells it, for Dev Pulse. */
  githubLanguage?: string;
}

export const DOMAINS: Domain[] = [
  {
    slug: "frontend",
    name: "Frontend",
    blurb: "Browsers, UI frameworks, CSS, web performance",
    keywords: ["frontend", "front-end", "css", "browser", "web components", "accessibility", "a11y", "dom", "web vitals", "ui library"],
  },
  {
    slug: "backend",
    name: "Backend",
    blurb: "APIs, services, databases, distributed systems",
    keywords: ["backend", "back-end", "api design", "microservices", "distributed systems", "message queue", "rest api", "rate limiting", "caching layer"],
  },
  {
    slug: "mobile",
    name: "Mobile",
    blurb: "iOS, Android and cross-platform apps",
    keywords: ["ios", "android", "mobile app", "swiftui", "jetpack compose", "app store", "play store", "xcode"],
  },
  {
    slug: "devops",
    name: "Cloud and DevOps",
    blurb: "Infrastructure, CI/CD, containers, observability",
    keywords: ["devops", "ci/cd", "infrastructure as code", "observability", "sre", "platform engineering", "serverless", "container orchestration", "container image", "containerization", "deployment pipeline", "incident", "outage", "postmortem"],
  },
  {
    slug: "data",
    name: "Data engineering",
    blurb: "Pipelines, warehouses, query engines, analytics",
    keywords: ["data engineering", "data pipeline", "data warehouse", "lakehouse", "etl", "olap", "query engine", "stream processing", "analytics engineering", "parquet", "iceberg"],
  },
  {
    slug: "ai",
    name: "AI and ML",
    blurb: "LLMs, agents, model training and inference",
    keywords: ["machine learning", "deep learning", "llm", "large language model", "neural network", "fine-tuning", "model inference", "inference server", "transformer model", "ai agent", "embedding model", "diffusion model", "rag"],
  },
  {
    slug: "security",
    name: "Security",
    blurb: "Vulnerabilities, supply chain, AppSec",
    keywords: ["vulnerability", "cve", "exploit", "supply chain attack", "malware", "ransomware", "zero-day", "appsec", "authentication bypass", "security advisory", "data breach", "phishing"],
  },
  {
    slug: "systems",
    name: "Systems and performance",
    blurb: "Kernels, compilers, runtimes, low-level work",
    keywords: ["kernel", "compiler", "memory allocator", "garbage collector", "performance tuning", "simd", "ebpf", "operating system", "file system", "concurrency", "lock-free", "embedded systems", "firmware"],
  },
  {
    slug: "gamedev",
    name: "Game development",
    blurb: "Engines, graphics, tooling",
    keywords: ["game engine", "unreal engine", "unity engine", "godot", "shader", "game development", "gamedev", "rendering pipeline"],
  },
  {
    slug: "tooling",
    name: "Dev tools and open source",
    blurb: "Editors, build tools, package managers, OSS news",
    keywords: ["open source", "package manager", "build tool", "bundler", "linter", "code editor", "developer tools", "developer experience", "monorepo", "version control"],
  },
  {
    slug: "leadership",
    name: "Engineering leadership",
    blurb: "Careers, teams, architecture decisions",
    keywords: ["engineering manager", "staff engineer", "tech lead", "career", "hiring", "interview", "engineering culture", "layoffs", "team topology", "technical debt"],
  },
];

export const STACK: StackItem[] = [
  // Languages
  { slug: "javascript", name: "JavaScript", kind: "language", domains: ["frontend", "backend"], aliases: ["javascript", "ecmascript", "tc39"], githubLanguage: "JavaScript" },
  { slug: "typescript", name: "TypeScript", kind: "language", domains: ["frontend", "backend"], aliases: ["typescript", "tsconfig"], githubLanguage: "TypeScript" },
  { slug: "python", name: "Python", kind: "language", domains: ["backend", "ai", "data"], aliases: ["python", "cpython", "pypi"], eol: "python", githubLanguage: "Python" },
  { slug: "go", name: "Go", kind: "language", domains: ["backend", "devops"], aliases: ["Golang", "golang", "goroutine", "goroutines", "Go 1", "in Go", "Go's", "with Go", "Go modules", "Go generics", "Go compiler", "Go runtime", "Go team", "written in Go"], caseSensitive: true, eol: "go", githubLanguage: "Go" },
  { slug: "rust", name: "Rust", kind: "language", domains: ["systems", "backend"], aliases: ["Rust", "rustc", "rustlang", "crates.io"], caseSensitive: true, githubLanguage: "Rust" },
  { slug: "java", name: "Java", kind: "language", domains: ["backend"], aliases: ["Java", "JVM", "OpenJDK", "JDK"], caseSensitive: true, eol: "oracle-jdk", githubLanguage: "Java" },
  { slug: "kotlin", name: "Kotlin", kind: "language", domains: ["backend", "mobile"], aliases: ["kotlin"], eol: "kotlin", githubLanguage: "Kotlin" },
  { slug: "swift", name: "Swift", kind: "language", domains: ["mobile"], aliases: ["SwiftUI", "Swift 5", "Swift 6", "Swift 7", "in Swift", "Swift package", "Swift concurrency", "Swift compiler", "swift.org"], caseSensitive: true, githubLanguage: "Swift" },
  { slug: "csharp", name: "C#", kind: "language", domains: ["backend", "gamedev"], aliases: ["c#", "csharp", ".net", "dotnet", "asp.net"], eol: "dotnet", githubLanguage: "C#" },
  { slug: "cpp", name: "C++", kind: "language", domains: ["systems", "gamedev"], aliases: ["c++", "cpp", "clang", "gcc"], githubLanguage: "C++" },
  { slug: "ruby", name: "Ruby", kind: "language", domains: ["backend"], aliases: ["Ruby", "rubygems"], caseSensitive: true, eol: "ruby", githubLanguage: "Ruby" },
  { slug: "php", name: "PHP", kind: "language", domains: ["backend"], aliases: ["php", "symfony", "packagist"], eol: "php", githubLanguage: "PHP" },
  { slug: "elixir", name: "Elixir", kind: "language", domains: ["backend"], aliases: ["elixir", "erlang", "phoenix liveview"], eol: "elixir", githubLanguage: "Elixir" },
  { slug: "zig", name: "Zig", kind: "language", domains: ["systems"], aliases: ["Zig", "ziglang"], caseSensitive: true, githubLanguage: "Zig" },
  { slug: "dart", name: "Dart", kind: "language", domains: ["mobile"], aliases: ["Dart", "dartlang"], caseSensitive: true, githubLanguage: "Dart" },

  // Frontend frameworks
  { slug: "react", name: "React", kind: "framework", domains: ["frontend"], aliases: ["ReactJS", "React.js", "React 18", "React 19", "React 20", "React Compiler", "React Server Components", "React hooks", "React app", "React component", "React components", "in React", "with React", "useEffect", "useState", "JSX"], caseSensitive: true, eol: "react" },
  { slug: "nextjs", name: "Next.js", kind: "framework", domains: ["frontend", "backend"], aliases: ["next.js", "nextjs", "turbopack"], eol: "nextjs" },
  { slug: "vue", name: "Vue", kind: "framework", domains: ["frontend"], aliases: ["Vue", "vue.js", "vuejs", "Nuxt"], caseSensitive: true, eol: "vue" },
  { slug: "svelte", name: "Svelte", kind: "framework", domains: ["frontend"], aliases: ["svelte", "sveltekit"] },
  { slug: "angular", name: "Angular", kind: "framework", domains: ["frontend"], aliases: ["Angular"], caseSensitive: true, eol: "angular" },
  { slug: "astro", name: "Astro", kind: "framework", domains: ["frontend"], aliases: ["Astro"], caseSensitive: true },
  { slug: "tailwind", name: "Tailwind CSS", kind: "framework", domains: ["frontend"], aliases: ["tailwind", "tailwindcss"], eol: "tailwind-css" },

  // Runtimes and backend frameworks
  { slug: "nodejs", name: "Node.js", kind: "runtime", domains: ["backend"], aliases: ["node.js", "nodejs", "npm"], eol: "nodejs" },
  { slug: "deno", name: "Deno", kind: "runtime", domains: ["backend"], aliases: ["Deno"], caseSensitive: true, eol: "deno" },
  { slug: "bun", name: "Bun", kind: "runtime", domains: ["backend"], aliases: ["Bun"], caseSensitive: true, eol: "bun" },
  { slug: "django", name: "Django", kind: "framework", domains: ["backend"], aliases: ["django"], eol: "django" },
  { slug: "fastapi", name: "FastAPI", kind: "framework", domains: ["backend"], aliases: ["fastapi", "pydantic"] },
  { slug: "rails", name: "Rails", kind: "framework", domains: ["backend"], aliases: ["Rails", "ruby on rails"], caseSensitive: true, eol: "rails" },
  { slug: "laravel", name: "Laravel", kind: "framework", domains: ["backend"], aliases: ["laravel"], eol: "laravel" },
  { slug: "spring", name: "Spring", kind: "framework", domains: ["backend"], aliases: ["Spring Boot", "Spring Framework"], caseSensitive: true, eol: "spring-boot" },
  { slug: "react-native", name: "React Native", kind: "framework", domains: ["mobile"], aliases: ["react native", "expo router", "expo sdk"] },
  { slug: "flutter", name: "Flutter", kind: "framework", domains: ["mobile"], aliases: ["flutter"] },
  { slug: "graphql", name: "GraphQL", kind: "tool", domains: ["backend", "frontend"], aliases: ["graphql"] },
  { slug: "webassembly", name: "WebAssembly", kind: "tool", domains: ["frontend", "systems"], aliases: ["webassembly", "wasm", "wasi"] },

  // Databases and data
  { slug: "postgres", name: "PostgreSQL", kind: "database", domains: ["backend", "data"], aliases: ["postgres", "postgresql", "pgvector"], eol: "postgresql" },
  { slug: "mysql", name: "MySQL", kind: "database", domains: ["backend", "data"], aliases: ["mysql", "mariadb"], eol: "mysql" },
  { slug: "sqlite", name: "SQLite", kind: "database", domains: ["backend"], aliases: ["sqlite", "libsql"] },
  { slug: "mongodb", name: "MongoDB", kind: "database", domains: ["backend", "data"], aliases: ["mongodb", "mongo"], eol: "mongodb" },
  { slug: "redis", name: "Redis", kind: "database", domains: ["backend"], aliases: ["redis", "valkey"], eol: "redis" },
  { slug: "elasticsearch", name: "Elasticsearch", kind: "database", domains: ["backend", "data"], aliases: ["elasticsearch", "opensearch"], eol: "elasticsearch" },
  { slug: "kafka", name: "Kafka", kind: "database", domains: ["backend", "data"], aliases: ["kafka", "redpanda"], eol: "apache-kafka" },
  { slug: "clickhouse", name: "ClickHouse", kind: "database", domains: ["data"], aliases: ["clickhouse"] },
  { slug: "duckdb", name: "DuckDB", kind: "database", domains: ["data"], aliases: ["duckdb"] },
  { slug: "spark", name: "Spark", kind: "database", domains: ["data"], aliases: ["Apache Spark", "PySpark", "Databricks"], caseSensitive: true },

  // Cloud and infrastructure
  { slug: "aws", name: "AWS", kind: "cloud", domains: ["devops"], aliases: ["AWS", "Amazon Web Services", "AWS Lambda", "DynamoDB", "EC2"], caseSensitive: true },
  { slug: "gcp", name: "Google Cloud", kind: "cloud", domains: ["devops"], aliases: ["GCP", "Google Cloud", "BigQuery", "Cloud Run"], caseSensitive: true },
  { slug: "azure", name: "Azure", kind: "cloud", domains: ["devops"], aliases: ["Azure"], caseSensitive: true },
  { slug: "cloudflare", name: "Cloudflare", kind: "cloud", domains: ["devops", "backend"], aliases: ["cloudflare", "cloudflare workers"] },
  { slug: "vercel", name: "Vercel", kind: "cloud", domains: ["frontend", "devops"], aliases: ["vercel"] },
  { slug: "kubernetes", name: "Kubernetes", kind: "tool", domains: ["devops"], aliases: ["kubernetes", "k8s", "kubectl", "helm chart"], eol: "kubernetes" },
  { slug: "docker", name: "Docker", kind: "tool", domains: ["devops"], aliases: ["docker", "dockerfile", "podman", "containerd"], eol: "docker-engine" },
  { slug: "terraform", name: "Terraform", kind: "tool", domains: ["devops"], aliases: ["terraform", "opentofu", "pulumi"], eol: "terraform" },
  { slug: "linux", name: "Linux", kind: "tool", domains: ["systems", "devops"], aliases: ["linux", "ubuntu", "debian", "systemd"], eol: "ubuntu" },
  { slug: "nginx", name: "nginx", kind: "tool", domains: ["devops", "backend"], aliases: ["nginx", "caddy", "envoy proxy"], eol: "nginx" },
  { slug: "github-actions", name: "GitHub Actions", kind: "tool", domains: ["devops", "tooling"], aliases: ["github actions", "gitlab ci"] },
  { slug: "observability", name: "Observability", kind: "tool", domains: ["devops"], aliases: ["opentelemetry", "prometheus", "grafana", "datadog"] },

  // AI
  { slug: "llm", name: "LLMs", kind: "ai", domains: ["ai"], aliases: ["LLM", "LLMs", "GPT", "Claude", "Gemini", "Llama", "prompt engineering", "context window"], caseSensitive: true },
  { slug: "agents", name: "AI agents", kind: "ai", domains: ["ai"], aliases: ["ai agent", "ai agents", "agentic", "langgraph", "langchain", "model context protocol", "tool calling"] },
  { slug: "pytorch", name: "PyTorch", kind: "ai", domains: ["ai"], aliases: ["pytorch", "tensorflow", "jax"] },
  { slug: "huggingface", name: "Hugging Face", kind: "ai", domains: ["ai"], aliases: ["hugging face", "huggingface"] },
  { slug: "mlops", name: "MLOps", kind: "ai", domains: ["ai", "devops"], aliases: ["mlops", "model serving", "vllm", "gpu cluster"] },

  // Tools
  { slug: "git", name: "Git", kind: "tool", domains: ["tooling"], aliases: ["Git", "git rebase", "git commit", "git merge", "Jujutsu"], caseSensitive: true },
  { slug: "vscode", name: "VS Code", kind: "tool", domains: ["tooling"], aliases: ["vs code", "vscode", "visual studio code", "cursor editor"] },
  { slug: "neovim", name: "Neovim", kind: "tool", domains: ["tooling"], aliases: ["neovim", "nvim", "vim"] },
  { slug: "testing", name: "Testing", kind: "tool", domains: ["tooling"], aliases: ["unit test", "integration test", "playwright", "vitest", "jest", "property-based testing", "fuzzing"] },
];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export const DOMAIN_BY_SLUG = new Map(DOMAINS.map((d) => [d.slug, d]));
export const STACK_BY_SLUG = new Map(STACK.map((s) => [s.slug, s]));

/** Every valid tag: all domain slugs plus all stack slugs. */
export const ALL_TAGS: string[] = [...DOMAINS.map((d) => d.slug), ...STACK.map((s) => s.slug)];
const TAG_SET = new Set(ALL_TAGS);

export function isTag(value: string): boolean {
  return TAG_SET.has(value);
}

/** Drop anything that is not in the vocabulary. Use on all external input. */
export function sanitizeTags(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((v): v is string => typeof v === "string" && isTag(v)))];
}

export function tagName(slug: string): string {
  return DOMAIN_BY_SLUG.get(slug)?.name ?? STACK_BY_SLUG.get(slug)?.name ?? slug;
}

// ---------------------------------------------------------------------------
// Tagging
// ---------------------------------------------------------------------------

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary match that also works for terms ending in symbols ("c++",
 * "c#", ".net"), where `\b` does not behave.
 */
function buildMatcher(terms: string[], caseSensitive: boolean): RegExp {
  const body = terms
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  return new RegExp(`(?<![A-Za-z0-9_])(?:${body})(?![A-Za-z0-9_])`, caseSensitive ? "" : "i");
}

const STACK_MATCHERS = STACK.map((item) => ({
  item,
  regex: buildMatcher(item.aliases, Boolean(item.caseSensitive)),
}));

const DOMAIN_MATCHERS = DOMAINS.map((domain) => ({
  domain,
  regex: buildMatcher(domain.keywords, false),
}));

/**
 * Tags for a piece of text, by keyword.
 *
 * Deliberately conservative: it is the cheap first pass that runs on every
 * item. The summariser refines tags later for the items that survive ranking.
 * A stack match implies its domains, so "Postgres 18 released" is findable by
 * someone who only selected "Backend".
 */
export function tagText(text: string, seed: string[] = []): string[] {
  const tags = new Set<string>(seed.filter(isTag));

  for (const { item, regex } of STACK_MATCHERS) {
    if (regex.test(text)) {
      tags.add(item.slug);
      for (const d of item.domains) tags.add(d);
    }
  }
  for (const { domain, regex } of DOMAIN_MATCHERS) {
    if (regex.test(text)) tags.add(domain.slug);
  }
  return [...tags];
}

/**
 * Everything a user's selections should match. Picking a stack item does not
 * widen to its whole domain (a React user did not ask for all of frontend),
 * but it is the reverse of how tagging widens, so the two meet in the middle.
 */
export function userTags(domains: string[], stack: string[]): string[] {
  return sanitizeTags([...domains, ...stack]);
}

/**
 * One paragraph describing the reader, embedded once and used as the query
 * vector for relevance. Written as natural language because that is what the
 * embedding model was trained on.
 */
export function interestText(domains: string[], stack: string[], level?: string): string {
  const d = domains.map((s) => DOMAIN_BY_SLUG.get(s)).filter(Boolean) as Domain[];
  const s = stack.map((x) => STACK_BY_SLUG.get(x)).filter(Boolean) as StackItem[];

  const parts: string[] = [];
  if (d.length) {
    parts.push(
      `A ${level && level !== "mid" ? `${level} ` : ""}software developer working in ${d
        .map((x) => `${x.name.toLowerCase()} (${x.blurb.toLowerCase()})`)
        .join("; ")}.`
    );
  }
  if (s.length) parts.push(`Uses ${s.map((x) => x.name).join(", ")} day to day.`);
  parts.push("Wants news, releases, engineering write-ups and deep dives relevant to that work.");
  return parts.join(" ");
}

/** endoflife.date products implied by a user's stack. */
export function eolProductsFor(stack: string[]): { product: string; name: string }[] {
  const out = new Map<string, string>();
  for (const slug of stack) {
    const item = STACK_BY_SLUG.get(slug);
    if (item?.eol) out.set(item.eol, item.name);
  }
  return [...out.entries()].map(([product, name]) => ({ product, name }));
}

/** GitHub languages implied by a user's stack, for Dev Pulse. */
export function githubLanguagesFor(stack: string[]): string[] {
  const out = new Set<string>();
  for (const slug of stack) {
    const lang = STACK_BY_SLUG.get(slug)?.githubLanguage;
    if (lang) out.add(lang);
  }
  return [...out];
}

export const LEVELS = [
  { slug: "student", name: "Student" },
  { slug: "junior", name: "Junior" },
  { slug: "mid", name: "Mid-level" },
  { slug: "senior", name: "Senior" },
  { slug: "staff", name: "Staff+" },
] as const;

export type Level = (typeof LEVELS)[number]["slug"];
