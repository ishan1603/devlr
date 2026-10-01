import { scheduledNewsletterFunction } from "@/lib/inngest/functions/scheduled-newsletter";
import { newsletterCronFunction } from "@/lib/inngest/functions/newsletter-cron";
import { ingestArticlesFunction } from "@/lib/inngest/functions/ingest-articles";

export const functions = [
  scheduledNewsletterFunction,
  newsletterCronFunction,
  ingestArticlesFunction,
];
