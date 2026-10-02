import { Inngest } from "inngest";

/**
 * In v4 the SDK defaults to cloud mode, which refuses to run without a signing
 * key. Local development talks to the dev server (`npm run dev:inngest`) and
 * has no key, so dev mode is switched on whenever this is not a production
 * build. INNGEST_DEV still overrides in either direction.
 */
export const inngest = new Inngest({
  id: "devlr",
  isDev: process.env.INNGEST_DEV ? process.env.INNGEST_DEV !== "0" : process.env.NODE_ENV !== "production",
  signingKey: process.env.INNGEST_SIGNING_KEY,
  // Several steps run inside one request until this much time has passed, then
  // the function checkpoints and resumes in a fresh one. Kept under the 60s a
  // free-tier serverless function is allowed.
  checkpointing: { maxRuntime: "45s" },
});

export const EVENTS = {
  enrich: "content.enrich",
  sendIssue: "issue.send",
  /** Scan one repository now. */
  guardScan: "guard.scan",
  /** A repository was pushed to. Scanned once the pushes stop. */
  guardPush: "guard.push",
  /** Scan everything that is due, without waiting for the next sweep. */
  guardSweep: "guard.sweep",
  /** A scan found something urgent for this reader. */
  guardAlert: "guard.alert",
} as const;

export interface GuardScanEvent {
  repoId: string;
  /** Read the repository's files again even if nothing says they changed. */
  force?: boolean;
}

export interface GuardAlertEvent {
  userId: string;
}

export interface SendIssueEvent {
  userId: string;
  kind: "scheduled" | "manual";
  /** Modules to include. Empty means "every active module". */
  modules: string[];
  /** Names the logical send; duplicates collapse on it. */
  dedupeKey: string;
}
