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

export type Section = StoriesSection | ReposSection | EolSection;

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

/** The single most important thing in the issue, for the subject line. */
export function leadStory(sections: Section[]): StoryItem | null {
  for (const s of sections) {
    if (s.type === "stories" && s.items.length > 0) return s.items[0];
  }
  return null;
}
