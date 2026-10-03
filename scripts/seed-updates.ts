import { createAdminClient } from "../lib/supabase-admin";

async function seed() {
  const supabase = createAdminClient();
  const { data: companies } = await supabase.from('companies').select('id, name').limit(10);
  
  if (!companies || companies.length === 0) {
    console.log("No companies found.");
    return;
  }

  const updates = companies.flatMap((c: any) => [
    {
      company_id: c.id,
      kind: 'wrote',
      title: `${c.name} Engineering: How we scaled our architecture in 2026`,
      url: `https://example.com/blog/${c.id}-scaling`,
      summary: `An in-depth look at the infrastructure changes ${c.name} made to handle 10x traffic with 99.99% uptime, open sourcing our new proxy layer.`,
    },
    {
      company_id: c.id,
      kind: 'shipped',
      title: `New Open Source Release from ${c.name}`,
      url: `https://github.com/example/${c.id}-oss`,
      summary: `We are thrilled to announce that our core rendering engine is now fully open source and available for the community to use and contribute to.`,
    }
  ]);

  const { error } = await supabase.from('company_updates').insert(updates);
  if (error) {
    console.error("Failed to insert updates:", error);
  } else {
    console.log(`Inserted ${updates.length} updates for ${companies.length} companies.`);
  }
}

seed();
