import { createAdminClient } from "@/lib/supabase-admin";
import { loadSeen } from "@/lib/delivery/ledger";
import { fetchJSON, mapLimit } from "@/lib/sources/http";
import { STACK, eolProductsFor } from "@/lib/topics/catalog";
import type { EolEntry, ModuleResult } from "@/lib/delivery/issue";

/**
 * EOL Watch: tell a reader before something they run stops getting fixes.
 *
 * Lifecycles come from endoflife.date, which tracks the vendors' own published
 * dates. Nothing here is inferred or predicted: if a release has no announced
 * end-of-life date, it is not mentioned.
 */

/**
 * Days before end of life at which a reader is told. Each milestone is sent
 * once: the ledger records `<product>:<cycle>:<milestone>` so "30 days left"
 * does not become a weekly nag.
 */
export const EOL_MILESTONES = [90, 30, 7, 0] as const;

/** Stop mentioning a release this long after it reached end of life. */
const PAST_EOL_GRACE_DAYS = 14;

interface EolApiCycle {
  cycle: string | number;
  releaseDate?: string;
  eol?: string | boolean;
  latest?: string;
  lts?: string | boolean;
  link?: string | null;
}

/** Every product any stack item maps to. About thirty requests, once a day. */
export function allEolProducts(): string[] {
  return [...new Set(STACK.map((s) => s.eol).filter(Boolean) as string[])];
}

function asDate(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export async function refreshEol(products: string[] = allEolProducts()) {
  const supabase = createAdminClient();

  const results = await mapLimit(products, 4, async (product) => {
    const cycles = await fetchJSON<EolApiCycle[]>(`https://endoflife.date/api/${product}.json`);
    return cycles
      // `eol: false` means no date has been announced; `true` means it already
      // happened with no date on record. Neither is something to count down to.
      .filter((c) => asDate(c.eol))
      .map((c) => ({
        product,
        cycle: String(c.cycle),
        release_date: asDate(c.releaseDate),
        eol_date: asDate(c.eol),
        is_lts: Boolean(c.lts),
        latest: c.latest ?? null,
        link: c.link ?? null,
        updated_at: new Date().toISOString(),
      }));
  });

  const rows = results.flatMap((r) => r.result ?? []);
  const failed = results.filter((r) => r.error).map((r) => `${r.item}: ${r.error}`);

  if (rows.length > 0) {
    const { error } = await supabase.from("eol_cycles").upsert(rows, { onConflict: "product,cycle" });
    if (error) throw new Error(`Failed to store EOL cycles: ${error.message}`);
  }
  return { products: products.length, cycles: rows.length, failed };
}

/**
 * The milestone a release currently sits at, or null if it is not yet close
 * enough to mention. 45 days left is past the 90-day mark and not yet at 30,
 * so it is the 90 milestone.
 */
export function milestoneFor(daysLeft: number): number | null {
  if (daysLeft < -PAST_EOL_GRACE_DAYS || daysLeft > EOL_MILESTONES[0]) return null;
  let current: number = EOL_MILESTONES[0];
  for (const milestone of EOL_MILESTONES) {
    if (daysLeft <= milestone) current = milestone;
  }
  return current;
}

export function daysUntil(date: string, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - today) / 86_400_000);
}

export async function assembleEol(
  profile: { user_id: string; stack: string[] },
  now: Date = new Date()
): Promise<ModuleResult> {
  const products = eolProductsFor(profile.stack);
  if (products.length === 0) return { sections: [], seen: [] };
  const nameOf = new Map(products.map((p) => [p.product, p.name]));

  const supabase = createAdminClient();
  const from = new Date(now.getTime() - PAST_EOL_GRACE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + EOL_MILESTONES[0] * 86_400_000).toISOString().slice(0, 10);

  const [{ data: rows, error }, { data: newest }, seen] = await Promise.all([
    supabase
      .from("eol_cycles")
      .select("product, cycle, eol_date, latest, link")
      .in("product", [...nameOf.keys()])
      .gte("eol_date", from)
      .lte("eol_date", to)
      .order("eol_date", { ascending: true }),
    // The most recently released cycle per product is where to move to.
    supabase
      .from("eol_cycles")
      .select("product, cycle, release_date")
      .in("product", [...nameOf.keys()])
      .order("release_date", { ascending: false, nullsFirst: false }),
    loadSeen(profile.user_id, "eol", 400),
  ]);
  if (error) throw new Error(`Failed to load EOL cycles: ${error.message}`);

  const newestCycle = new Map<string, string>();
  for (const row of newest ?? []) {
    if (!newestCycle.has(row.product as string)) newestCycle.set(row.product as string, row.cycle as string);
  }

  const entries: EolEntry[] = [];
  for (const row of rows ?? []) {
    const daysLeft = daysUntil(row.eol_date as string, now);
    const milestone = milestoneFor(daysLeft);
    if (milestone === null) continue;

    const ref = `${row.product}:${row.cycle}:${milestone}`;
    if (seen.refs.has(ref)) continue;

    const latest = newestCycle.get(row.product as string);
    entries.push({
      ref,
      product: nameOf.get(row.product as string) ?? (row.product as string),
      cycle: row.cycle as string,
      eolDate: row.eol_date as string,
      daysLeft,
      latest: latest && latest !== row.cycle ? latest : undefined,
      link: (row.link as string) ?? `https://endoflife.date/${row.product}`,
    });
  }

  if (entries.length === 0) return { sections: [], seen: [] };

  return {
    sections: [{ type: "eol", module: "eol_watch", label: "eol watch", title: "Reaching end of life", entries }],
    seen: entries.map((e) => ({ module: "eol_watch" as const, itemType: "eol", ref: e.ref })),
  };
}
