"use client";

import { useEffect, useState } from "react";
import { GitBranch, Lock } from "lucide-react";
import { AddRepoForm } from "@/components/app/repo-actions";
import { Badge, Skeleton, buttonClass } from "@/components/ui";
import { listRepos } from "@/lib/api-client";
import type { GuardAccount, RepoSummary } from "@/lib/guard/view";

/**
 * The optional step: point Devlr at some repositories.
 *
 * Two ways in, and neither is required to finish setup. Connecting GitHub
 * leaves the page and comes back to this same step, which is why what is
 * already connected is loaded fresh each time it is shown.
 */
export default function RepoStep({
  connectHref,
}: {
  /** Where "Connect GitHub" goes. Null in the demo, where there is nothing to connect to. */
  connectHref: string | null;
}) {
  // undefined: loading. null: could not load, which only hides the summary.
  const [state, setState] = useState<{ repos: RepoSummary[]; account: GuardAccount } | null | undefined>(undefined);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listRepos()
      .then((result) => !cancelled && setState(result))
      .catch(() => !cancelled && setState(null));
    return () => {
      cancelled = true;
    };
  }, [version]);

  const account = state?.account;
  const watched = (state?.repos ?? []).filter((repo) => repo.watching);
  const connected = (account?.accounts.length ?? 0) > 0;
  const atLimit = account ? watched.length >= account.limit : false;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-line bg-surface p-5">
        <p className="text-[15px] font-semibold tracking-tight">From GitHub</p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">
          {account && !account.githubConfigured
            ? "This deployment has no GitHub App yet, so private repositories are not available. Public ones can be watched by name below."
            : "You pick the repositories on GitHub's own screen. Devlr gets read access to their contents and metadata, nothing else, and stores no token."}
        </p>

        {state === undefined ? (
          <Skeleton className="mt-4 h-10 w-44" />
        ) : connected ? (
          <p className="mt-4 flex flex-wrap items-center gap-2 text-[14px]">
            <GitBranch className="size-4 text-accent" />
            <span className="font-medium">Connected as {account!.accounts.map((a) => a.login).join(", ")}</span>
            <a href={connectHref ? `${connectHref}?mode=install&from=/onboarding` : "#"} className="text-[13px] text-accent hover:underline">
              Choose repositories
            </a>
          </p>
        ) : (
          account?.githubConfigured !== false && (
            <a href={connectHref ? `${connectHref}?from=/onboarding` : "#"} className={buttonClass("primary", "md", "mt-4")}>
              <GitBranch className="size-4" />
              Connect GitHub
            </a>
          )
        )}
      </div>

      <div className="rounded-xl border border-line bg-surface p-5">
        <p className="text-[15px] font-semibold tracking-tight">Or by name</p>
        <p className="mb-4 mt-1 text-[13px] text-muted">
          Any public repository: one of yours, or an open-source project you depend on.
        </p>
        <AddRepoForm disabled={atLimit} onAdded={() => setVersion((v) => v + 1)} />
      </div>

      {watched.length > 0 && (
        <div>
          <p className="mb-2 font-mono text-[12px] text-subtle">
            watching {watched.length}
            {account ? ` of ${account.limit}` : ""}
          </p>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {watched.map((repo) => (
              <li key={repo.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-5 py-3">
                <span className="font-mono text-[13px] font-medium [overflow-wrap:anywhere]">{repo.full_name}</span>
                {repo.is_private && (
                  <Badge>
                    <Lock className="size-3" />
                    private
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="font-mono text-[12px] text-subtle">
        Optional. Skip it now and it is under Repos whenever you want it.
      </p>
    </div>
  );
}
