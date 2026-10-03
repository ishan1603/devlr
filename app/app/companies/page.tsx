import type { Metadata } from "next";
import { getMe } from "@/lib/profile";
import { createClient } from "@/lib/server";
import { Page, PageHeader } from "@/components/ui";
import CompanyFollowButton from "@/components/app/CompanyFollowButton";
import CompanyActions from "@/components/app/CompanyActions";

export const metadata: Metadata = { title: "Companies" };

export default async function CompaniesPage() {
  const me = (await getMe())!;
  const supabase = await createClient();

  // Get all verified companies and indicate which ones the user follows
  const { data: allCompanies } = await supabase
    .from("companies")
    .select("id, name, domain, slug, verified")
    .eq("verified", true)
    .order("name");

  const { data: followed } = await supabase
    .from("user_companies")
    .select("company_id")
    .eq("user_id", me.profile.user_id);

  const followedSet = new Set(followed?.map((f) => f.company_id) || []);

  const companies = (allCompanies || []).map(c => ({
    ...c,
    isFollowing: followedSet.has(c.id)
  }));

  return (
    <Page>
      <PageHeader 
        title="Company Radar" 
        description="Follow engineering organizations to receive updates when they ship, publish blog posts, or experience incidents." 
        action={<CompanyActions />}
      />

      <div className="surface border border-white/5 rounded-lg overflow-hidden mt-8">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface-sunken border-b border-white/5 text-subtle">
            <tr>
              <th className="px-6 py-4 font-medium uppercase tracking-wider text-xs">Company</th>
              <th className="px-6 py-4 font-medium uppercase tracking-wider text-xs">Domain</th>
              <th className="px-6 py-4 font-medium uppercase tracking-wider text-xs text-right">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {companies.map((company) => (
              <tr key={company.id} className="group hover:bg-white/[0.02] transition-colors">
                <td className="px-6 py-4">
                  <div className="font-medium text-ink">{company.name}</div>
                  <div className="text-xs text-muted mt-0.5">@{company.slug}</div>
                </td>
                <td className="px-6 py-4 text-muted">
                  <a href={`https://${company.domain}`} target="_blank" rel="noopener noreferrer" className="hover:text-accent transition-colors">
                    {company.domain}
                  </a>
                </td>
                <td className="px-6 py-4 text-right">
                  <CompanyFollowButton companyId={company.id} initialFollowing={company.isFollowing} />
                </td>
              </tr>
            ))}
            {companies.length === 0 && (
              <tr>
                <td colSpan={3} className="px-6 py-8 text-center text-subtle">
                  No verified companies available yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Page>
  );
}
