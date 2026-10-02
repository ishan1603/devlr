import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/server";
import { appUrl } from "@/lib/delivery/tokens";
import {
  GITHUB_RETURN_COOKIE,
  exchangeCode,
  fetchIdentity,
  githubAppConfigured,
  installUrl,
  listUserInstallationRepos,
  listUserInstallations,
  returnPath,
  signState,
  verifyState,
  type AccessibleRepo,
} from "@/lib/github/app";
import { linkInstallations } from "@/lib/guard/repos";
import { EVENTS, inngest, type GuardScanEvent } from "@/lib/inngest/client";

/** More installations than this on one account is not a reader, it is a mistake. */
const MAX_INSTALLATIONS = 10;

/**
 * The reader is back from GitHub.
 *
 * Nothing in this request is trusted on its own. The `state` proves this
 * server started the round trip for this signed-in reader. The `code` is
 * exchanged with GitHub for a token that acts as the person who came back,
 * and that token is what establishes who they are and which installations
 * they can reach. An `installation_id` in the URL is accepted only if GitHub
 * lists it for that person: it is a number anyone can type.
 *
 * The token is used for those few requests and then goes out of scope. It is
 * never stored.
 */
export async function GET(request: NextRequest) {
  const base = appUrl();
  const store = await cookies();
  const back = returnPath(store.get(GITHUB_RETURN_COOKIE)?.value);
  const finish = (outcome: string) => NextResponse.redirect(`${base}${back}?github=${outcome}`);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(`${base}/signin`);
  if (!githubAppConfigured()) return finish("unavailable");

  const params = request.nextUrl.searchParams;
  if (!verifyState(params.get("state"), user.id)) return finish("expired");

  // Present only when the App is set to ask who is installing it. Without it
  // there is no way to tell whose installation this is, so nothing is linked.
  const code = params.get("code");
  if (!code) return finish(params.get("error") ? "declined" : "unverified");

  try {
    const token = await exchangeCode(code);
    const identity = await fetchIdentity(token);
    const installations = (await listUserInstallations(token)).slice(0, MAX_INSTALLATIONS);

    const claimed = params.get("installation_id");
    if (claimed && !installations.some((i) => String(i.id) === claimed)) return finish("forbidden");

    // Known to GitHub, but the App is installed nowhere they can reach yet.
    if (installations.length === 0) return NextResponse.redirect(installUrl(signState(user.id)));

    const repos = new Map<number, AccessibleRepo[]>();
    for (const installation of installations) {
      repos.set(installation.id, installation.suspended ? [] : await listUserInstallationRepos(token, installation.id));
    }

    const linked = await linkInstallations(user.id, identity, installations, repos);

    if (linked.toScan.length > 0) {
      try {
        await inngest.send(
          linked.toScan.map((repoId) => ({ name: EVENTS.guardScan, data: { repoId } satisfies GuardScanEvent }))
        );
      } catch (err) {
        // Linked and stored either way. The sweep will scan them.
        console.error("github: could not queue the first scans:", err);
      }
    }

    store.delete(GITHUB_RETURN_COOKIE);
    return finish(linked.repositories > 0 ? "connected" : "empty");
  } catch (err) {
    console.error("github: linking failed:", err);
    return finish("error");
  }
}
