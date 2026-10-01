/**
 * Outbound HTTP for ingestion.
 *
 * Every request identifies itself honestly and carries a timeout. We are
 * polling other people's servers on a schedule, so the User-Agent says who is
 * asking and where to complain.
 */

function appUrl() {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "https://devlr.vercel.app").replace(/\/$/, "");
}

export function userAgent(): string {
  return `Devlr/1.0 (+${appUrl()}; developer news digest)`;
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  accept?: string;
}

export async function politeFetch(url: string, options: FetchOptions = {}): Promise<Response> {
  const attempt = () =>
    fetch(url, {
      headers: {
        "user-agent": userAgent(),
        accept: options.accept ?? "*/*",
        ...options.headers,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });

  try {
    return await attempt();
  } catch (err) {
    // A dropped connection is retried once. An HTTP error is an answer, not a
    // failure to connect, so it is returned to the caller and never retried
    // here. Timeouts are not retried either: a slow server will be slow again.
    if (err instanceof Error && err.name === "TimeoutError") throw err;
    await new Promise((resolve) => setTimeout(resolve, 400 + Math.random() * 400));
    return attempt();
  }
}

export async function fetchJSON<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await politeFetch(url, { accept: "application/json", ...options });
  if (!response.ok) {
    throw new Error(`${new URL(url).hostname} answered ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Run tasks with a concurrency ceiling, collecting failures instead of throwing. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<{ item: T; result?: R; error?: string }[]> {
  const out: { item: T; result?: R; error?: string }[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      try {
        out[index] = { item: items[index], result: await fn(items[index]) };
      } catch (err) {
        out[index] = { item: items[index], error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Decode the handful of entities that survive in feed text, and strip tags. */
export function htmlToText(html: string | undefined | null, maxLength = 600): string {
  if (!html) return "";
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&hellip;/gi, "...")
    .replace(/&mdash;|&ndash;/gi, ", ")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return n > 31 && n < 65536 ? String.fromCharCode(n) : " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength).replace(/\s+\S*$/, "")}...` : text;
}
