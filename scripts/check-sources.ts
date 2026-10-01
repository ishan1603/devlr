import { SOURCES } from "@/lib/sources/registry";
import { fetchSource } from "@/lib/sources/fetch";
import { mapLimit } from "@/lib/sources/http";

/**
 * Fetches every source in the registry once and reports what came back.
 *
 *   npm run sources:check
 *
 * Feeds move and die without telling anyone. Run this after editing the
 * registry, and whenever ingestion logs start showing errors.
 */
async function main() {
  const results = await mapLimit(SOURCES, 8, (source) => fetchSource(source));

  let dead = 0;
  let empty = 0;
  for (const { item: source, result, error } of results) {
    if (error) {
      dead++;
      console.log(`  FAIL   ${source.id.padEnd(28)} ${error}`);
    } else if (!result || result.items.length === 0) {
      empty++;
      console.log(`  empty  ${source.id.padEnd(28)} (no items in the last 14 days)`);
    } else {
      const newest = result.items[0];
      console.log(
        `  ok     ${source.id.padEnd(28)} ${String(result.items.length).padStart(3)} items  ` +
          `${(newest.publishedAt ?? "").slice(0, 10)}  ${newest.title.slice(0, 60)}`
      );
    }
  }

  console.log(`\n${SOURCES.length} sources: ${SOURCES.length - dead - empty} ok, ${empty} empty, ${dead} failing.`);
  if (dead > 0) process.exitCode = 1;
}

main();
