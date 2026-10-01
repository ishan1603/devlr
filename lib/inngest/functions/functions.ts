import {
  enrichContent,
  ingestContent,
  pruneData,
  refreshLifecycles,
  refreshPulse,
} from "@/lib/inngest/functions/content";
import { scheduleIssues, sendIssue } from "@/lib/inngest/functions/delivery";

export const functions = [
  ingestContent,
  enrichContent,
  refreshPulse,
  refreshLifecycles,
  pruneData,
  scheduleIssues,
  sendIssue,
];
