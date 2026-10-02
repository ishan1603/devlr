import type { ContentKind } from "@/lib/sources/types";
import type { Module } from "@/lib/delivery/schedule";

/**
 * An issue as data.
 *
 * This is the contract between everything that decides *what* a reader gets
 * and everything that decides *how it looks*. The email, the plain-text part,
 * the "view in browser" page and the personal feed are all renderings of this
 * one structure, which is why it is stored on the delivery row.
 *
 * Models contribute strings to it (a subject, an intro, a summary). They never
 * produce markup.
 */

export interface StoryItem {
  /** Cluster id: the identity of the story, used for seen-history and feedback. */
  ref: string;
  canonicalUrl: string;
  url: string;
  title: string;
  summary: string;
  source: string;
  site: string;
  kind: ContentKind;
  tags: string[];
  /** Short facts shown under the title: "HN 320 points", "6 min read". */
  meta: string[];
  /** Other outlets that covered the same story. */
  alsoCoveredBy: { name: string; url: string }[];
  /** Signed links for "more like this" / "less like this". Absent in previews. */
  feedback?: { more: string; less: string };
}

export interface StoriesSection {
  type: "stories";
  module: Module;
  /** Terminal-style label, e.g. "news". Rendered as `// news`. */
  label: string;
  title: string;
  items: StoryItem[];
}

export interface PulseRepo {
  fullName: string;
  url: string;
  description: string;
  language: string;
  stars: number;
  blurb?: string;
}

export interface ReposSection {
  type: "repos";
  module: Module;
  label: string;
  title: string;
  repos: PulseRepo[];
}

export interface EolEntry {
  ref: string;
  product: string;
  cycle: string;
  eolDate: string;
  daysLeft: number;
  /** A newer supported version to move to, when known. */
  latest?: string;
  link?: string;
}

export interface EolSection {
  type: "eol";
  module: Module;
  label: string;
  title: string;
  entries: EolEntry[];
}

export type GuardPriority = "urgent" | "high" | "medium" | "low";

/** One thing to fix in one repository: a package, a runtime, a missing lockfile. */
export interface GuardEntry {
  /** `<repo id>:<package key>`, recorded with the delivery. */
  ref: string;
  /** Full name of the repository, "owner/name". */
  repo: string;
  priority: GuardPriority;
  title: string;
  /** The same thing in a few words, short enough to be a subject line. */
  headline: string;
  /** What to do about it. From the scan, never from a model. */
  action: string;
  /** A command to paste, when one reliably does the job. */
  command?: string;
  /** The advisory's own page, or the repository's page in Devlr when there are several. */
  url: string;
  /** Short facts under the title: "direct", "exploited in the wild", "2 new". */
  meta: string[];
}

export interface GuardRepoSummary {
  fullName: string;
  grade: string;
  score: number;
  /** Entries in the repository's report, announced before or not. */
  toFix: number;
  url: string;
}

export interface GuardSection {
  type: "guard";
  module: Module;
  label: string;
  title: string;
  /** The repositories this section is about, with their current health. */
  repos: GuardRepoSummary[];
  entries: GuardEntry[];
  /** Things with news that did not fit above, by name only. */
  also: string[];
  /** Everything, in the app. */
  url: string;
  /**
   * Set on copies shown outside the reader's inbox and account, where the
   * details have been removed. What is wrong with someone's private code does
   * not belong on a page that opens for anyone holding its link.
   */
  redacted?: boolean;
}

export interface LearnSection {
  type: "learn";
  module: Module;
  label: string;
  title: string;
  id: string | number;
  question: string;
  hints: string[];
  url: string;
}

export interface CompanyUpdate {
  kind: "shipped" | "wrote" | "news" | "incident";
  title: string;
  url: string;
  summary?: string;
}

export interface CompanySection {
  type: "company_radar";
  module: Module;
  label: string;
  title: string;
  companies: {
    name: string;
    updates: CompanyUpdate[];
  }[];
}

export interface ReleaseItem {
  package: string;
  version: string;
  breaking: boolean;
  notes: string;
  url: string;
}

export interface ReleaseSection {
  type: "release_radar";
  module: Module;
  label: string;
  title: string;
  releases: ReleaseItem[];
}

export type Section = StoriesSection | ReposSection | EolSection | GuardSection | LearnSection | CompanySection | ReleaseSection;

export interface Issue {
  subject: string;
  preheader: string;
  /** One or two sentences opening the issue. */
  intro: string;
  /** ISO date the issue was assembled. */
  date: string;
  sections: Section[];
  /** True when a model wrote the subject and intro, false for the template. */
  aiEdited: boolean;
}

/** What a module contributes to an issue. */
export interface ModuleResult {
  sections: Section[];
  /** Recorded after a successful send so nothing is shown twice. */
  seen: { module: Module; itemType: string; ref: string; canonicalUrl?: string | null }[];
  /**
   * Repo Guard finding ids this issue announces. Marked as told once the
   * email has actually gone, which is what stops them being sent again.
   */
  notified?: number[];
}

export function countItems(sections: Section[]): number {
  let n = 0;
  for (const s of sections) {
    if (s.type === "stories") n += s.items.length;
    else if (s.type === "repos") n += s.repos.length;
    else n += s.entries.length;
  }
  return n;
}

/** The Repo Guard section, when the issue has one. */
export function guardSection(sections: Section[]): GuardSection | null {
  return sections.find((s): s is GuardSection => s.type === "guard") ?? null;
}

/**
 * An issue with everything that should not travel removed: the reader's
 * feedback links, and what Repo Guard found in their repositories. For the
 * "read in browser" page and the feed, both of which open with a link alone.
 */
export function shareable(issue: Issue): Issue {
  const guarded = issue.sections.some((s) => s.type === "guard");
  // When Repo Guard leads, the subject and preheader name the package and the
  // repository, and an issue that is only Repo Guard opens by naming them too.
  const neutral = guarded
    ? {
        subject: "Repo Guard has something for you",
        preheader: "Open Devlr to see what was found in your repositories.",
        intro: issue.sections.every((s) => s.type === "guard") ? "" : issue.intro,
      }
    : {};

  return {
    ...issue,
    ...neutral,
    sections: issue.sections.map((section) => {
      if (section.type === "stories") {
        return { ...section, items: section.items.map((item) => ({ ...item, feedback: undefined })) };
      }
      if (section.type === "guard") {
        return { ...section, repos: [], entries: [], also: [], redacted: true };
      }
      if (section.type === "learn") {
        // Only include the title/url, not the hints which aren't needed in a feed
        return { ...section, hints: [] };
      }
      return section;
    }),
  };
}

/** The single most important thing in the issue, for the subject line. */
export function leadStory(sections: Section[]): StoryItem | null {
  for (const s of sections) {
    if (s.type === "stories" && s.items.length > 0) return s.items[0];
  }
  return null;
}
