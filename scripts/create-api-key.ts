import { createAdminClient } from "@/lib/supabase-admin";
import { generateApiKey } from "@/lib/platform/keys";

/**
 * Provisions a tenant and mints an API key.
 *
 *   npm run platform:key -- "Acme Newsletters"
 *
 * The raw key is printed once and never stored; only its SHA-256 hash reaches
 * the database. If it is lost, mint a new one and revoke the old -- there is
 * deliberately no way to recover it.
 */

async function main() {
  const name = process.argv[2];

  if (!name) {
    console.error('Usage: npm run platform:key -- "<tenant name>"');
    process.exit(1);
  }

  const supabase = createAdminClient();

  // Reuse an existing tenant of the same name so re-running this to add a second
  // key does not silently create a duplicate tenant with its own isolated
  // suppression list and quota.
  const { data: existing, error: lookupError } = await supabase
    .from("platform_tenants")
    .select("id, name")
    .eq("name", name)
    .maybeSingle();

  if (lookupError) throw new Error(`tenant lookup failed: ${lookupError.message}`);

  let tenantId: string;

  if (existing) {
    tenantId = existing.id;
    console.log(`Using existing tenant "${name}" (${tenantId})`);
  } else {
    const { data: created, error: insertError } = await supabase
      .from("platform_tenants")
      .insert({ name })
      .select("id")
      .single();

    if (insertError) throw new Error(`tenant creation failed: ${insertError.message}`);

    tenantId = created.id;
    console.log(`Created tenant "${name}" (${tenantId})`);
  }

  const key = generateApiKey();

  const { error: keyError } = await supabase.from("platform_api_keys").insert({
    tenant_id: tenantId,
    name: "cli",
    key_prefix: key.prefix,
    key_hash: key.hash,
  });

  if (keyError) throw new Error(`key creation failed: ${keyError.message}`);

  console.log("");
  console.log("  API key (shown once, store it now):");
  console.log("");
  console.log(`    ${key.raw}`);
  console.log("");
  console.log("  Try it:");
  console.log("");
  console.log(`    curl -X POST http://localhost:3000/api/v1/messages \\`);
  console.log(`      -H "Authorization: Bearer ${key.raw}" \\`);
  console.log(`      -H "Content-Type: application/json" \\`);
  console.log(`      -H "Idempotency-Key: demo-1" \\`);
  console.log(`      -d '{"to":"you@example.com","from":"noreply@example.com",`);
  console.log(`           "subject":"First platform send","text":"It works."}'`);
  console.log("");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
