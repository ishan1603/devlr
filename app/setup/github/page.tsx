import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, Eyebrow, Page, buttonClass } from "@/components/ui";
import { appUrl } from "@/lib/delivery/tokens";
import { githubAppConfig } from "@/lib/github/app";
import { appManifest, setupEnabled } from "@/lib/github/manifest";

export const metadata: Metadata = { title: "Set up GitHub", robots: { index: false, follow: false } };

/**
 * One-time setup for whoever runs this deployment: create the GitHub App that
 * Repo Guard connects through. Off in production unless DEVLR_SETUP=1.
 */
export default function SetupGithubPage() {
  if (!setupEnabled()) notFound();

  const base = appUrl();
  const manifest = appManifest(base);
  const existing = githubAppConfig();

  return (
    <Page className="max-w-2xl">
      <Eyebrow>setup</Eyebrow>
      <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-[-0.025em] sm:text-[34px]">
        Create the GitHub App
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">
        Repo Guard reads repositories through a GitHub App that you own. This creates it with the right settings in
        one step, then shows you the six values to put in your environment.
      </p>

      {existing && (
        <p className="mt-6 rounded-xl border border-line bg-surface px-4 py-3 text-[14px] text-muted">
          An App is already configured here: <span className="font-mono text-fg">{existing.slug}</span>. Creating
          another makes a second, separate App.
        </p>
      )}

      <Card className="mt-6">
        <div className="space-y-4 p-5">
          <div>
            <p className="text-[14px] font-semibold">What it will be allowed to do</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[14px] text-muted">
              <li>Read the contents and metadata of repositories someone chooses to give it. Nothing else.</li>
              <li>Ask GitHub who is installing it, so an installation can only be linked by someone who can reach it.</li>
              <li>
                {manifest.hook_attributes
                  ? "Receive a webhook when one of those repositories is pushed to."
                  : "No webhooks: this address is not reachable from GitHub. Repositories are still rescanned every day."}
              </li>
            </ul>
          </div>

          <div>
            <p className="text-[14px] font-semibold">Where it will send people back to</p>
            <p className="mt-1 break-all font-mono text-[12px] text-subtle">{manifest.callback_urls[0]}</p>
            <p className="mt-2 text-[13px] text-muted">
              Taken from NEXT_PUBLIC_APP_URL. An App made here on localhost only works on localhost: make another from
              your deployed address for production.
            </p>
          </div>

          <a href="/setup/github/start" className={buttonClass("primary", "md")}>
            Create it on GitHub
          </a>
        </div>
      </Card>
    </Page>
  );
}
