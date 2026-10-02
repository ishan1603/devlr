import {
  enrichContent,
  ingestContent,
  pruneData,
  refreshLifecycles,
  refreshPulse,
} from "@/lib/inngest/functions/content";
import { scheduleIssues, sendIssue } from "@/lib/inngest/functions/delivery";
import { scanPushedRepo, scanRepo, sendGuardAlert, sweepRepos } from "@/lib/inngest/functions/guard";
import { generateLearnQuestions } from "@/lib/inngest/functions/learn";

export const functions = [
  ingestContent,
  enrichContent,
  refreshPulse,
  refreshLifecycles,
  pruneData,
  scheduleIssues,
  sendIssue,
  scanRepo,
  scanPushedRepo,
  sweepRepos,
  sendGuardAlert,
  generateLearnQuestions,
];
