import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Client } from "pg";

/**
 * Applies supabase/migrations/*.sql in filename order.
 *
 * Deliberately not the Supabase CLI: that needs an interactive login and a
 * ~100 MB binary behind an install script. This needs one connection string.
 *
 *   npm run db:migrate            apply anything not yet applied
 *   npm run db:migrate -- --status   list what is and is not applied
 *
 * Each file runs inside its own transaction, so a failure leaves the database
 * exactly as it was before that file started.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error(
      "SUPABASE_DB_URL is not set.\n" +
        "Supabase dashboard -> Connect -> Session pooler -> copy the URI into .env.local.\n" +
        "See SETUP.md."
    );
    process.exit(1);
  }

  const statusOnly = process.argv.includes("--status");
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    await client.query(`
      create table if not exists public._migrations (
        name       text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      );
      alter table public._migrations enable row level security;
    `);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      "select name, checksum from public._migrations"
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let ran = 0;
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 16);
      const previous = applied.get(file);

      if (previous === checksum) {
        if (statusOnly) console.log(`  applied   ${file}`);
        continue;
      }

      // Migrations are idempotent, so an edited file is simply re-applied
      // rather than treated as an error.
      const label = previous ? "changed" : "pending";
      if (statusOnly) {
        console.log(`  ${label}   ${file}`);
        continue;
      }

      process.stdout.write(`  applying  ${file} ... `);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          `insert into public._migrations (name, checksum) values ($1, $2)
           on conflict (name) do update set checksum = excluded.checksum, applied_at = now()`,
          [file, checksum]
        );
        await client.query("commit");
        console.log("ok");
        ran++;
      } catch (err) {
        await client.query("rollback");
        console.log("FAILED");
        throw err;
      }
    }

    if (!statusOnly) {
      console.log(ran === 0 ? "Database is up to date." : `Applied ${ran} migration(s).`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
