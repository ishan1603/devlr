/**
 * The style guard.
 *
 * Every piece of model-written text passes through here before it can reach an
 * inbox. A prompt can ask a model not to use em dashes; only code can promise
 * it. Two layers:
 *
 *   cleanProse()   rewrites what can be fixed mechanically (dashes, spacing)
 *   lintProse()    reports what cannot, so the caller can ask for a rewrite or
 *                  fall back to a template
 *
 * Nothing in this file calls a model, so all of it is unit-tested.
 */

// ---------------------------------------------------------------------------
// Dashes
// ---------------------------------------------------------------------------

const EM_DASH = /\u2014/g;
const EN_DASH = /\u2013/g;

/**
 * Remove em and en dashes without changing what the sentence says.
 *
 * A numeric range ("2019–2021", "10–20ms") keeps its meaning as a hyphen. A
 * dash between clauses becomes a comma, which is the closest ordinary
 * punctuation. A dash at the start of a line was a list marker.
 */
export function replaceDashes(text: string): string {
  return (
    text
      // "2019–2021", "v1–v2"
      .replace(/(\d)[ \t]*[\u2013\u2014][ \t]*(\d)/g, "$1-$2")
      // A line that opens with a dash is a bullet, not a clause break.
      .replace(/^[ \t]*[\u2013\u2014][ \t]*/gm, "- ")
      // "word — word", "word—word", and the typed stand-ins " -- " and " - ".
      // Horizontal whitespace only: a newline is a paragraph, not a clause.
      .replace(/[ \t]*[\u2013\u2014][ \t]*/g, ", ")
      .replace(/[ \t]+--[ \t]+/g, ", ")
      .replace(/(\w)[ \t]+-[ \t]+(\w)/g, "$1, $2")
      // The rewrite can leave ", ," or " ,": tidy up after ourselves.
      .replace(/,[ \t]*,/g, ",")
      .replace(/[ \t]+,/g, ",")
      .replace(/,[ \t]*([.!?;:])/g, "$1")
      .replace(/,[ \t]*$/gm, "")
  );
}

/** Remove emoji and the variation selectors and joiners that trail them. */
export function stripEmoji(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Mechanical fixes that are always safe to apply. */
export function cleanProse(text: string): string {
  return replaceDashes(text)
    // Models like the non-breaking hyphen ("wall\u2011time"). It renders as a
    // box in some monospace fonts and is a tell in its own right.
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/\u00a0/g, " ")
    // Curly quotes survive most mail clients, but not all plain-text ones.
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[ \t]+/g, " ")
    .replace(/ +\n/g, "\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Phrases that give machine-written text away
// ---------------------------------------------------------------------------

/**
 * Kept as plain strings, matched case-insensitively on word boundaries. This
 * is a list of tells, not a list of bad words: each one is fine in isolation
 * and a reliable signal in aggregate.
 */
export const BANNED_PHRASES: readonly string[] = [
  "delve",
  "delves",
  "delving",
  "tapestry",
  "game-changer",
  "game changer",
  "game-changing",
  "revolutionize",
  "revolutionizes",
  "revolutionizing",
  "revolutionary",
  "unleash",
  "unleashes",
  "unlock the power",
  "harness the power",
  "supercharge",
  "skyrocket",
  "seamless",
  "seamlessly",
  "cutting-edge",
  "ever-evolving",
  "ever evolving",
  "fast-paced world",
  "in today's world",
  "in the world of",
  "in the realm of",
  "it's worth noting",
  "it is worth noting",
  "worth noting that",
  "it's important to note",
  "it is important to note",
  "let's dive in",
  "let's dive into",
  "dive into the world",
  "buckle up",
  "look no further",
  "stay ahead of the curve",
  "paradigm shift",
  "a testament to",
  "plays a crucial role",
  "plays a pivotal role",
  "plays a vital role",
  "highlights the importance",
  "underscores the importance",
  "underscores the need",
  "navigate the complexities",
  "navigating the complexities",
  "embark on",
  "at the end of the day",
  "in conclusion",
  "needless to say",
  "whether you're a",
  "the landscape of",
  "evolving landscape",
  "rapidly evolving",
  "not only",
  "treasure trove",
  "elevate your",
  "take your skills to the next level",
  "to the next level",
  "exciting news",
  "we're excited",
  "we are excited",
  "i hope this email finds you well",
];

/** Words that push a subject line toward the spam folder. */
export const SPAM_TRIGGERS: readonly string[] = [
  "free",
  "act now",
  "urgent",
  "limited time",
  "click here",
  "click below",
  "winner",
  "guarantee",
  "guaranteed",
  "100%",
  "risk-free",
  "no obligation",
  "congratulations",
  "last chance",
  "don't miss",
  "do not miss",
  "you won't believe",
  "shocking",
  "earn money",
  "cash",
  "bonus",
  "$$$",
];

/**
 * All-caps tokens that are legitimately all caps. Without this the "no
 * shouting" rule would reject every security advisory ever written.
 */
const ACRONYMS = new Set([
  "API", "APIS", "AWS", "GCP", "CLI", "CPU", "GPU", "CVE", "CVSS", "CSS", "HTML", "HTTP", "HTTPS",
  "JSON", "YAML", "XML", "SQL", "JWT", "SDK", "TLS", "SSL", "DNS", "CDN", "RCE", "XSS", "CSRF",
  "SSRF", "EOL", "LTS", "LLM", "LLMS", "RAG", "NPM", "PNPM", "RFC", "TCP", "UDP", "IO", "OS",
  "IDE", "CI", "CD", "ORM", "REST", "GRPC", "WASM", "KEV", "EPSS", "OSV", "GHSA", "SBOM",
  "UI", "UX", "AI", "ML", "DB", "PR", "PRS", "VM", "VMS", "SSH", "URL", "URLS", "UUID", "ARM",
  "RISC", "SIMD", "JIT", "AOT", "GC", "TC39", "PEP", "W3C", "IETF", "OAUTH", "SAML", "SSO",
  "ACID", "CRDT", "GA", "RC", "HN", "DEV", "TS", "JS", "PHP", "IOS", "MCP", "CNCF", "LSP",
  "ESM", "CJS", "SSR", "SSG", "ISR", "PPR", "RSC", "DX", "QA", "SRE", "SLA", "SLO", "OLAP",
  "OLTP", "ETL", "KV", "S3", "EC2", "K8S", "NAT", "VPC", "IAM", "MFA", "OTP", "FIDO", "TPM",
  "NVIDIA", "POSIX", "ASCII", "GDPR", "HIPAA", "NIST", "OWASP", "CISA", "MITRE", "WEBGL",
  "COBOL", "LINQ", "NUMA", "RDMA", "NVME", "RAID", "BIOS", "UEFI", "ECMA", "ANSI", "IEEE",
]);

// ---------------------------------------------------------------------------
// Linting
// ---------------------------------------------------------------------------

/**
 * ", enabling faster builds." A sentence that tacks its point on as a trailing
 * participle is the single most recognisable rhythm of machine-written
 * summaries. People write a second sentence.
 */
const TRAILING_PARTICIPLE =
  /,\s+(?:thereby\s+|thus\s+)?(enabling|ensuring|highlighting|allowing|making|improving|simplifying|providing|offering|showcasing|underscoring|emphasizing|emphasising|reflecting|marking|paving|demonstrating|signaling|signalling|reducing|boosting|streamlining|helping|giving|letting|opening|raising|positioning|cementing|solidifying)\b/i;

export interface StyleIssue {
  rule:
    | "dash"
    | "participle"
    | "banned-phrase"
    | "exclamation"
    | "emoji"
    | "shouting"
    | "spam-trigger"
    | "too-long"
    | "empty"
    | "markup";
  detail: string;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a phrase on word boundaries, tolerating either apostrophe style.
 * `\b` does not work next to "$" or "%", so those fall back to plain search.
 */
function containsPhrase(haystack: string, phrase: string): boolean {
  const normalised = haystack.toLowerCase().replace(/[\u2018\u2019]/g, "'");
  if (!/^[\w]/.test(phrase) || !/[\w]$/.test(phrase)) return normalised.includes(phrase);
  // Hyphens count as word characters here, so "free" does not fire on
  // "use-after-free" or "lock-free", which are real things developers read.
  return new RegExp(`(?<![\\w-])${escapeRegExp(phrase)}(?![\\w-])`, "i").test(normalised);
}

const EMOJI = /\p{Extended_Pictographic}/u;

function shoutedWords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s/]+/)) {
    // Digits are dropped first: "CVE-2026-1234" and "HTTP2" are identifiers,
    // not shouting. Four letters or fewer is almost always an acronym.
    const word = raw.replace(/[^A-Za-z]/g, "");
    if (word.length < 5) continue;
    if (!/^[A-Z]+$/.test(word)) continue;
    if (ACRONYMS.has(word)) continue;
    out.push(word);
  }
  return out;
}

/** Problems that cleanProse cannot fix on its own. Empty array means clean. */
export function lintProse(text: string): StyleIssue[] {
  const issues: StyleIssue[] = [];
  if (!text.trim()) return [{ rule: "empty", detail: "no text" }];

  if (EM_DASH.test(text) || EN_DASH.test(text)) {
    issues.push({ rule: "dash", detail: "contains an em or en dash" });
  }
  // Global regexes keep state between .test() calls.
  EM_DASH.lastIndex = 0;
  EN_DASH.lastIndex = 0;

  for (const phrase of BANNED_PHRASES) {
    if (containsPhrase(text, phrase)) issues.push({ rule: "banned-phrase", detail: phrase });
  }

  const participle = text.match(TRAILING_PARTICIPLE);
  if (participle) issues.push({ rule: "participle", detail: participle[1].toLowerCase() });

  if (text.includes("!")) issues.push({ rule: "exclamation", detail: "exclamation mark" });
  if (EMOJI.test(text)) issues.push({ rule: "emoji", detail: "emoji" });
  // Only real HTML tags: "Array<string>" and "<script>" are things articles
  // are legitimately about.
  if (/<\/?(p|br|div|span|a|b|i|strong|em|ul|ol|li|h[1-6])(\s[^>]*)?\/?>|\*\*|^#{1,6}\s/im.test(text)) {
    issues.push({ rule: "markup", detail: "contains HTML or Markdown" });
  }

  for (const word of shoutedWords(text)) issues.push({ rule: "shouting", detail: word });

  return issues;
}

export const SUBJECT_MAX_LENGTH = 60;

/**
 * Subject lines carry extra rules: the inbox list truncates past ~60
 * characters, and filters weigh the subject far more heavily than the body.
 */
export function lintSubject(subject: string): StyleIssue[] {
  const issues = lintProse(subject);

  if (subject.length > SUBJECT_MAX_LENGTH) {
    issues.push({ rule: "too-long", detail: `${subject.length} characters, limit ${SUBJECT_MAX_LENGTH}` });
  }
  for (const trigger of SPAM_TRIGGERS) {
    if (containsPhrase(subject, trigger)) issues.push({ rule: "spam-trigger", detail: trigger });
  }
  return issues;
}

/**
 * Trim a subject to the limit on a word boundary, without an ellipsis: a
 * subject that ends "..." reads as clickbait, one that ends on a whole word
 * just reads as short.
 */
export function fitSubject(subject: string, max = SUBJECT_MAX_LENGTH): string {
  const cleaned = cleanProse(subject).replace(/[!]+/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return cut.slice(0, lastSpace > 20 ? lastSpace : max).replace(/[,;:\s]+$/, "");
}

/** Feedback for a model on what to fix, in the plainest possible terms. */
export function describeIssues(issues: StyleIssue[]): string {
  const lines = new Set<string>();
  for (const issue of issues) {
    switch (issue.rule) {
      case "dash":
        lines.add("Remove every em dash and en dash. Use a comma or a full stop.");
        break;
      case "participle":
        lines.add(
          `Do not end a clause with ", ${issue.detail} ...". State that point as its own short sentence.`
        );
        break;
      case "banned-phrase":
        lines.add(`Do not use the phrase "${issue.detail}".`);
        break;
      case "exclamation":
        lines.add("No exclamation marks.");
        break;
      case "emoji":
        lines.add("No emoji.");
        break;
      case "shouting":
        lines.add(`Do not write "${issue.detail}" in capitals.`);
        break;
      case "spam-trigger":
        lines.add(`The subject must not contain "${issue.detail}".`);
        break;
      case "too-long":
        lines.add(`The subject is too long (${issue.detail}).`);
        break;
      case "markup":
        lines.add("Plain text only. No HTML and no Markdown.");
        break;
      case "empty":
        lines.add("The text was empty.");
        break;
    }
  }
  return [...lines].join(" ");
}

/**
 * The voice, stated once and shared by every prompt. Kept next to the lint
 * rules so the instructions and the enforcement cannot drift apart.
 */
export const VOICE = [
  "You write for working software developers. Write the way a sharp colleague talks:",
  "plain, specific, a little dry. Lead with the concrete fact. Name the thing, the version,",
  "the number. Short sentences. Contractions are fine.",
  "Hard rules: never use an em dash or an en dash, use a comma or a full stop instead.",
  "No exclamation marks, no emoji, no hype, no marketing voice, no rhetorical questions.",
  "Never write: delve, landscape, seamless, game-changer, revolutionary, unleash,",
  "cutting-edge, 'it's worth noting', 'in today's world', 'not only ... but also',",
  "'let's dive in', 'underscores', 'a testament to'.",
  "Never tack a point onto a sentence with a trailing participle such as ', enabling X',",
  "', ensuring Y', ', highlighting Z' or ', making it easier'. Write a second sentence instead.",
  "Never state anything the supplied source text does not support.",
].join(" ");
