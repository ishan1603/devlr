import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

/**
 * A real Postgres for the migration tests.
 *
 * PGlite is Postgres compiled to WebAssembly, with pgvector. It runs inside the
 * test process, so this needs no database, no Docker and no network, and it is
 * still the actual SQL in supabase/migrations being executed by an actual
 * Postgres. A mock could not tell us whether a policy really hides a row or a
 * trigger really fires.
 *
 * Supabase provides a few things a bare Postgres does not: the `auth` schema,
 * the `anon`, `authenticated` and `service_role` roles, and default grants on
 * new tables. The setup below recreates just enough of that for the migrations
 * to mean what they mean in production.
 *
 * Each test file runs in its own process, so the database here is per file.
 */

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

const SUPABASE_STUBS = `
  create schema if not exists auth;
  create schema if not exists extensions;

  create role anon nologin;
  create role authenticated nologin;
  -- What background jobs connect as. It skips row level security, as it does
  -- on Supabase, but still needs the right to call a function.
  create role service_role nologin bypassrls;

  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb not null default '{}'
  );

  -- Supabase resolves this from the request's JWT. Here it reads a session
  -- setting, which the helpers below set to impersonate a user.
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;

  -- Supabase grants table access to these roles by default and relies on row
  -- level security as the gate. Reproducing that is what makes the policy
  -- tests meaningful: with these grants, RLS is the only thing in the way.
  grant usage on schema public, extensions, auth to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export let db: PGlite;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export async function applyMigrations() {
  for (const file of migrationFiles()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    } catch (err) {
      throw new Error(`${file} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export async function openDatabase() {
  db = await PGlite.create({ extensions: { vector } });
  await db.exec(SUPABASE_STUBS);
  await applyMigrations();
}

export async function closeDatabase() {
  await db.close();
}

export async function rows<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

export async function createUser(email = `${randomUUID()}@example.com`, meta: object = {}): Promise<string> {
  const [user] = await rows<{ id: string }>(
    "insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id",
    [email, JSON.stringify(meta)]
  );
  return user.id;
}

/** Run queries as a signed-in user (or as an anonymous visitor when id is null). */
export async function as<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
  await db.exec(`set role ${userId ? "authenticated" : "anon"}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

/** Run queries the way a background job does: no user, no row level security. */
export async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("set role service_role");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

/** Postgres error code of a rejected statement, or null if it succeeded. */
export async function errorCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}
