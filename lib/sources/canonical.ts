/**
 * URL identity.
 *
 * The same article arrives as `https://www.example.com/post/?utm_source=hn`,
 * `http://example.com/post` and `https://m.example.com/post#comments`. The
 * canonical form is what `content_items.canonical_url` is unique on, so
 * getting it wrong in one direction duplicates stories and in the other merges
 * two different articles. When in doubt this keeps URLs distinct: a missed
 * duplicate is caught later by title and embedding, a wrong merge is not.
 */

/** Query parameters that track the click and never change the content. */
const TRACKING_PARAMS = new Set([
  "ref", "ref_src", "ref_url", "referrer", "source", "src", "fbclid", "gclid", "gclsrc", "dclid",
  "msclkid", "mc_cid", "mc_eid", "igshid", "si", "share", "shared", "cmp", "cmpid", "campaign",
  "_hsenc", "_hsmi", "hsctatracking", "mkt_tok", "oly_anon_id", "oly_enc_id", "vero_id",
  "trk", "trkcampaign", "sk", "spm", "yclid", "wt_mc", "ncid", "sr_share", "smid", "rss",
  "feed", "via", "at_medium", "at_campaign", "guccounter", "guce_referrer", "guce_referrer_sig",
]);

const TRACKING_PREFIXES = ["utm_", "pk_", "mtm_", "hsa_", "_ga", "ga_"];

/** Subdomains that serve the same page as the bare host. */
const STRIP_SUBDOMAINS = /^(www|m|mobile|amp)\./;

function isTracking(name: string): boolean {
  const key = name.toLowerCase();
  return TRACKING_PARAMS.has(key) || TRACKING_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Canonical form of a URL, or null if it is not a usable http(s) link.
 */
export function canonicalizeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.protocol = "https:";
  url.hash = "";
  url.username = "";
  url.password = "";
  url.port = "";
  url.hostname = url.hostname.toLowerCase().replace(STRIP_SUBDOMAINS, "");

  // Tracking params out, the rest sorted so parameter order is not identity.
  const kept: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    if (!isTracking(name)) kept.push([name, value]);
  }
  kept.sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [name, value] of kept) url.searchParams.append(name, value);

  let path = url.pathname.replace(/\/{2,}/g, "/");
  // AMP variants of the same article.
  path = path.replace(/\/amp\/?$/i, "/").replace(/\.amp$/i, "");
  if (path.length > 1) path = path.replace(/\/+$/, "");

  const host = url.hostname;

  // arXiv: abs, pdf and versioned links are one paper.
  if (host === "arxiv.org") {
    const m = path.match(/^\/(?:abs|pdf|html)\/([\w.\/-]+?)(?:v\d+)?(?:\.pdf)?$/);
    if (m) {
      path = `/abs/${m[1]}`;
      url.search = "";
    }
  }

  // GitHub paths are case-insensitive for owner and repo.
  if (host === "github.com") {
    const parts = path.split("/");
    if (parts.length >= 3) {
      parts[1] = parts[1].toLowerCase();
      parts[2] = parts[2].toLowerCase();
      path = parts.join("/");
    }
  }

  url.pathname = path || "/";
  return url.toString();
}

/**
 * The URL a reader is actually sent to: the original, minus tracking.
 *
 * Unlike the canonical form this keeps the host exactly as published, since
 * some sites only answer on `www.`. It only removes what identifies the click,
 * because passing someone else's campaign tags through our email would
 * attribute our readers' visits to their feed reader.
 */
export function cleanUrl(input: string): string {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    for (const name of [...url.searchParams.keys()]) {
      if (isTracking(name)) url.searchParams.delete(name);
    }
    return url.toString();
  } catch {
    return "";
  }
}

/** Registrable-ish host for display and per-site caps: "blog.cloudflare.com". */
export function siteOf(input: string): string {
  try {
    return new URL(input).hostname.toLowerCase().replace(STRIP_SUBDOMAINS, "");
  } catch {
    return "";
  }
}

/** Only http(s) links ever reach a reader; `javascript:` must never render. */
export function safeHttpUrl(input: string | null | undefined): string {
  if (!input) return "";
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}
