import type { Issue } from "@/lib/delivery/issue";

/**
 * The issue shown on the landing page.
 *
 * Taken from a real run of the pipeline on 2026-10-01 (`npm run email:preview`):
 * the articles, figures and summaries are what it produced, lightly trimmed.
 * It shows what the product actually sends rather than an idealised mock.
 * Refresh it by running the preview again and copying `.preview/issue.json`.
 */
export const SAMPLE_ISSUE: Issue = {
  subject: "EDG opens its C++ front end, Shopify drops React Native",
  preheader: "Plus a 4.57% faster Rust compiler, and Next.js 15 reaches end of life in 20 days.",
  intro:
    "EDG's C++ front end is now public under the C++ Alliance, and Shopify is leaving React Native for native development. Next.js 15 has 20 days of support left.",
  date: "2026-10-01T08:00:00.000Z",
  aiEdited: true,
  sections: [
    {
      type: "stories",
      module: "digest",
      label: "top story",
      title: "Top story",
      items: [
        {
          ref: "sample-1",
          canonicalUrl: "https://edgcpp.org/",
          url: "https://edgcpp.org/#transition",
          title: "EDG C++ front-end goes public",
          summary:
            "The source for EDG's C++ front end became public on September 30. The C++ Alliance has taken over stewardship and is accepting contributions.",
          source: "Hacker News",
          site: "edgcpp.org",
          kind: "news",
          tags: ["cpp", "systems"],
          meta: ["212 points on HN", "3 min read"],
          alsoCoveredBy: [],
        },
      ],
    },
    {
      type: "stories",
      module: "digest",
      label: "news",
      title: "News",
      items: [
        {
          ref: "sample-2",
          canonicalUrl: "https://newsletter.pragmaticengineer.com/p/shopify-native-mobile",
          url: "https://newsletter.pragmaticengineer.com/p/shopify-native-mobile",
          title: "Why has Shopify dropped React Native?",
          summary:
            "Shopify will stop using React Native and move to native mobile development. It cites AI coding tools that reduce the need for a cross-platform layer.",
          source: "The Pragmatic Engineer",
          site: "newsletter.pragmaticengineer.com",
          kind: "news",
          tags: ["react-native", "mobile"],
          meta: ["13 min read"],
          alsoCoveredBy: [],
        },
        {
          ref: "sample-3",
          canonicalUrl: "https://vercel.com/changelog/vercel-agent-now-installs-private-packages-from-npm-and-custom-registries",
          url: "https://vercel.com/changelog/vercel-agent-now-installs-private-packages-from-npm-and-custom-registries",
          title: "Vercel Agent now installs private packages from npm and custom registries",
          summary:
            "The agent can install private npm, pnpm and Yarn packages using shared environment variables. Credentials stay outside the sandbox, so the agent itself cannot read them.",
          source: "Vercel Blog",
          site: "vercel.com",
          kind: "release",
          tags: ["vercel", "nodejs"],
          meta: [],
          alsoCoveredBy: [],
        },
      ],
    },
    {
      type: "stories",
      module: "digest",
      label: "deep dives",
      title: "Deep dives",
      items: [
        {
          ref: "sample-4",
          canonicalUrl: "https://nnethercote.github.io/2026/09/30/how-to-speed-up-the-rust-compiler-in-september-2026.html",
          url: "https://nnethercote.github.io/2026/09/30/how-to-speed-up-the-rust-compiler-in-september-2026.html",
          title: "How to speed up the Rust compiler in September 2026",
          summary:
            "Benchmarks from July to September show a 4.57% mean wall-time reduction, with 555 of 629 tests improving. Key contributors include PGO for Clippy and the LLVM 23 upgrade.",
          source: "Lobsters",
          site: "nnethercote.github.io",
          kind: "blog",
          tags: ["rust", "systems"],
          meta: ["71 on Lobsters", "5 min read"],
          alsoCoveredBy: [],
        },
        {
          ref: "sample-5",
          canonicalUrl: "https://mechanicalrabbit.github.io/FunSQL.jl/stable/two-kinds-of-sql-query-builders",
          url: "https://mechanicalrabbit.github.io/FunSQL.jl/stable/two-kinds-of-sql-query-builders/",
          title: "Two Kinds of SQL Query Builders",
          summary:
            "FunSQL offers a compositional, data-oriented interface that covers the full range of SQL features. That lets code generate complex queries programmatically.",
          source: "Lobsters",
          site: "mechanicalrabbit.github.io",
          kind: "blog",
          tags: ["postgres", "data"],
          meta: ["37 on Lobsters", "9 min read"],
          alsoCoveredBy: [],
        },
      ],
    },
    {
      type: "eol",
      module: "eol_watch",
      label: "eol watch",
      title: "Reaching end of life",
      entries: [
        { ref: "nextjs:15:30", product: "Next.js", cycle: "15", eolDate: "2026-10-21", daysLeft: 20, latest: "16" },
        { ref: "postgresql:14:90", product: "PostgreSQL", cycle: "14", eolDate: "2026-11-12", daysLeft: 42, latest: "18" },
      ],
    },
    {
      type: "repos",
      module: "dev_pulse",
      label: "dev pulse",
      title: "New and climbing on GitHub",
      repos: [
        {
          fullName: "zai-org/ZCode",
          url: "https://github.com/zai-org/ZCode",
          description: "Z.ai's coding agent harness. Powerful, intelligent, extensible.",
          language: "TypeScript",
          stars: 7271,
        },
        {
          fullName: "CopilotKit/openmuse",
          url: "https://github.com/CopilotKit/openmuse",
          description: "A personal agent with a browser, terminal, files, and work that keeps going.",
          language: "TypeScript",
          stars: 3497,
        },
      ],
    },
  ],
};
