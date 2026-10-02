"use client";

import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Check, Copy, Plus, RefreshCw, Trash2, Unplug } from "lucide-react";
import { Button, Input, Switch, cx } from "@/components/ui";
import { useNotification } from "@/contexts/NotificationContext";
import { addRepo, disconnectGithub, removeRepo, scanRepo, setRepoWatching } from "@/lib/api-client";

/**
 * The parts of the Repos screens that do something.
 *
 * Each one calls the API and then asks the router to refresh, so the server
 * components around them re-render from the database. Nothing here keeps its
 * own copy of a repository's state for longer than the request takes.
 */

/** What to tell someone when they come back from GitHub, by the outcome in the URL. */
const GITHUB_OUTCOMES: Record<string, { tone: "success" | "info" | "error"; title: string; message: string }> = {
  connected: { tone: "success", title: "GitHub connected", message: "Your repositories are being scanned now." },
  empty: {
    tone: "info",
    title: "Connected, with no repositories",
    message: "The Devlr app has no repositories selected yet. Choose some on GitHub.",
  },
  expired: { tone: "error", title: "That took too long", message: "The link back from GitHub expired. Connect again." },
  unverified: {
    tone: "error",
    title: "Could not confirm your GitHub account",
    message: "GitHub did not say who was connecting, so nothing was linked. Connect again.",
  },
  declined: { tone: "info", title: "Not connected", message: "You cancelled on GitHub. Nothing was changed." },
  forbidden: {
    tone: "error",
    title: "Not your installation",
    message: "That GitHub installation is not one your account can reach.",
  },
  unavailable: {
    tone: "info",
    title: "GitHub is not set up here yet",
    message: "You can still watch public repositories by name.",
  },
  error: { tone: "error", title: "Could not connect GitHub", message: "Something went wrong talking to GitHub. Try again in a minute." },
};

/** Shows the result of the GitHub round trip once, then tidies the URL. */
export function GithubOutcome({ outcome }: { outcome?: string }) {
  const { showSuccess, showInfo, showError } = useNotification();
  const router = useRouter();
  const pathname = usePathname();
  const shown = useRef(false);

  useEffect(() => {
    const known = outcome ? GITHUB_OUTCOMES[outcome] : undefined;
    if (!known || shown.current) return;
    shown.current = true;
    const show = known.tone === "success" ? showSuccess : known.tone === "error" ? showError : showInfo;
    show(known.title, known.message);
    // So a reload does not announce it again.
    router.replace(pathname, { scroll: false });
  }, [outcome, pathname, router, showError, showInfo, showSuccess]);

  return null;
}

/** Watch a public repository by typing its name. */
export function AddRepoForm({ disabled, onAdded }: { disabled?: boolean; onAdded?: () => void }) {
  const router = useRouter();
  const { showError, showSuccess } = useNotification();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      const { repo } = await addRepo(value.trim());
      setValue("");
      showSuccess(`Watching ${repo.fullName}`, "The first scan takes a few seconds.");
      onAdded?.();
      router.refresh();
    } catch (err) {
      showError("Could not add that repository", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
      <label htmlFor="add-repo" className="sr-only">
        Public repository, as owner/name or a github.com link
      </label>
      <Input
        id="add-repo"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="owner/name or a github.com link"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className="font-mono text-[13px] sm:flex-1"
        disabled={disabled}
      />
      <Button type="submit" variant="secondary" loading={busy} disabled={disabled || !value.trim()}>
        {!busy && <Plus className="size-4" />}
        Watch
      </Button>
    </form>
  );
}

export function WatchSwitch({ id, name, watching }: { id: string; name: string; watching: boolean }) {
  const router = useRouter();
  const { showError } = useNotification();
  // Shown at once, and it falls back to the real value by itself if the
  // request fails: the optimistic value only lives as long as the transition.
  const [shown, setShown] = useOptimistic(watching);
  const [busy, startTransition] = useTransition();

  function toggle(next: boolean) {
    startTransition(async () => {
      setShown(next);
      try {
        await setRepoWatching(id, next);
        router.refresh();
      } catch (err) {
        showError(next ? "Could not start watching" : "Could not stop watching", err instanceof Error ? err.message : undefined);
      }
    });
  }

  return <Switch checked={shown} onChange={toggle} disabled={busy} label={`Watch ${name}`} />;
}

export function ScanButton({ id, disabled }: { id: string; disabled?: boolean }) {
  const router = useRouter();
  const { showError } = useNotification();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      await scanRepo(id);
      router.refresh();
    } catch (err) {
      showError("Could not start a scan", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={run} loading={busy} disabled={disabled}>
      {!busy && <RefreshCw className="size-3.5" />}
      Scan now
    </Button>
  );
}

export function RemoveRepoButton({ id, name, redirectTo }: { id: string; name: string; redirectTo: string }) {
  const router = useRouter();
  const { showError } = useNotification();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      await removeRepo(id);
      router.push(redirectTo);
      router.refresh();
    } catch (err) {
      showError("Could not remove it", err instanceof Error ? err.message : undefined);
      setBusy(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
        <Trash2 className="size-3.5" />
        Remove
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-[13px] text-muted">Remove {name} and its report?</span>
      <Button variant="danger" size="sm" onClick={remove} loading={busy}>
        Remove
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
        Keep
      </Button>
    </span>
  );
}

export function DisconnectButton({ installationId, login }: { installationId: number; login: string }) {
  const router = useRouter();
  const { showError, showSuccess } = useNotification();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    setBusy(true);
    try {
      await disconnectGithub(installationId);
      showSuccess(`Disconnected ${login}`, "Its repositories and their reports were removed from Devlr.");
      router.refresh();
    } catch (err) {
      showError("Could not disconnect", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
        <Unplug className="size-3.5" />
        Disconnect
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-[13px] text-muted">Remove {login}&apos;s repositories from Devlr?</span>
      <Button variant="danger" size="sm" onClick={disconnect} loading={busy}>
        Disconnect
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
        Cancel
      </Button>
    </span>
  );
}

/** Copies a command or a snippet. Says so, briefly, in place. */
export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused. The text is on screen to select by hand.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : `${label}: ${text}`}
      className={cx(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 font-mono text-[11px] text-subtle transition-colors hover:bg-surface hover:text-fg",
        className
      )}
    >
      {copied ? <Check className="size-3.5 text-accent" /> : <Copy className="size-3.5" />}
      {copied ? "copied" : "copy"}
    </button>
  );
}

/**
 * Re-renders the page every few seconds while a scan is under way, and stops
 * by itself: a scan that has not finished in two minutes has failed, and
 * polling for it forever would only spend requests.
 */
export function ScanPoller({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
      router.refresh();
      if (ticks >= 30) clearInterval(timer);
    }, 4000);
    return () => clearInterval(timer);
  }, [active, router]);

  return null;
}
