import type { Metadata } from "next";

export const metadata: Metadata = { title: "Companies (Demo)" };

export default function DemoCompaniesPage() {
  const companies = [
    { id: 1, name: "Vercel", slug: "vercel", domain: "vercel.com", isFollowing: true },
    { id: 2, name: "Supabase", slug: "supabase", domain: "supabase.com", isFollowing: true },
    { id: 3, name: "Stripe", slug: "stripe", domain: "stripe.com", isFollowing: false },
    { id: 4, name: "OpenAI", slug: "openai", domain: "openai.com", isFollowing: false },
    { id: 5, name: "Anthropic", slug: "anthropic", domain: "anthropic.com", isFollowing: true },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-12">
      <header className="space-y-2">
        <h1 className="text-2xl tracking-tight">Company Radar</h1>
        <p className="text-subtle">
          Follow engineering organizations to receive updates when they ship, publish blog posts, or experience incidents.
        </p>
      </header>

      <div className="surface border border-white/5 rounded-lg overflow-hidden">
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
                  <button
                    className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                      company.isFollowing 
                        ? "bg-surface-sunken text-muted hover:text-danger hover:bg-danger/10"
                        : "bg-accent/10 text-accent hover:bg-accent hover:text-on-accent"
                    }`}
                  >
                    {company.isFollowing ? "Following" : "Follow"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
