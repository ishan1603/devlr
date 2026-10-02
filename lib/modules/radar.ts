import { createAdminClient } from "@/lib/supabase-admin";
import type { ComposeProfile } from "@/lib/delivery/compose";
import type { CompanySection, ReleaseSection, ModuleResult } from "@/lib/delivery/issue";

export async function assembleCompanyRadar(profile: ComposeProfile): Promise<ModuleResult> {
  const supabase = createAdminClient();

  // Fetch the companies this user follows
  const { data: userCompanies } = await supabase
    .from("user_companies")
    .select("company_id")
    .eq("user_id", profile.user_id);

  if (!userCompanies || userCompanies.length === 0) {
    return { sections: [], seen: [] };
  }

  const companyIds = userCompanies.map((c) => c.company_id);

  // Fetch recent updates for these companies (last 7 days for example)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: updates } = await supabase
    .from("company_updates")
    .select("id, kind, title, url, summary, company:companies(name)")
    .in("company_id", companyIds)
    .gte("published_at", sevenDaysAgo)
    .order("published_at", { ascending: false });

  if (!updates || updates.length === 0) {
    return { sections: [], seen: [] };
  }

  // Group by company name
  const companiesMap = new Map<string, any[]>();
  const seen: ModuleResult["seen"] = [];

  for (const update of updates) {
    const companyName = (update.company as any).name;
    if (!companiesMap.has(companyName)) {
      companiesMap.set(companyName, []);
    }
    companiesMap.get(companyName)!.push({
      kind: update.kind,
      title: update.title,
      url: update.url,
      summary: update.summary,
    });
    seen.push({ module: "company_radar", itemType: "update", ref: update.id.toString() });
  }

  const section: CompanySection = {
    type: "company_radar",
    module: "company_radar",
    label: "radar",
    title: "Company Radar",
    companies: Array.from(companiesMap.entries()).map(([name, upds]) => ({
      name,
      updates: upds,
    })),
  };

  return { sections: [section], seen };
}

export async function assembleReleaseRadar(profile: ComposeProfile): Promise<ModuleResult> {
  const supabase = createAdminClient();

  // For a real implementation, we would query the user's `repositories` or `user_stars`
  // and match them against `package_releases`.
  // For the sake of this resume project, we'll just fetch recent releases from the DB
  // that happened in the last 7 days.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: releases } = await supabase
    .from("package_releases")
    .select("id, ecosystem, name, version, breaking_changes, release_notes_md, url")
    .gte("published_at", sevenDaysAgo)
    .order("published_at", { ascending: false })
    .limit(5);

  if (!releases || releases.length === 0) {
    return { sections: [], seen: [] };
  }

  const seen: ModuleResult["seen"] = [];
  const items = releases.map((r) => {
    seen.push({ module: "release_radar", itemType: "release", ref: r.id.toString() });
    return {
      package: r.name,
      version: r.version,
      breaking: r.breaking_changes,
      notes: r.release_notes_md || "",
      url: r.url || `https://github.com/releases/${r.name}`,
    };
  });

  const section: ReleaseSection = {
    type: "release_radar",
    module: "release_radar",
    label: "releases",
    title: "Release Radar",
    releases: items,
  };

  return { sections: [section], seen };
}
