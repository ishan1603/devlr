export type ContentKind = "news" | "blog" | "tutorial" | "release" | "paper" | "discussion" | "repo";

export type SourceKind = "rss" | "hn" | "lobsters" | "devto" | "hf_papers";

/**
 * How a source's items should be read.
 *   news         press coverage
 *   official     a project or vendor speaking for itself (releases, changelogs)
 *   engineering  a company's engineering blog
 *   blog         an individual's writing
 *   tutorial     how-to content
 *   research     papers
 *   aggregator   links to other people's work (HN, Lobsters)
 */
export type SourceCategory =
  | "news"
  | "official"
  | "engineering"
  | "blog"
  | "tutorial"
  | "research"
  | "aggregator";

export interface SourceDef {
  /** Stable id, stored in the database. Never rename. */
  id: string;
  kind: SourceKind;
  name: string;
  /** What gets fetched: a feed URL or an API endpoint. */
  url: string;
  siteUrl?: string;
  category: SourceCategory;
  /** Tags every item from this source starts with. */
  topics: string[];
  /**
   * 0 to 1. How much an item is trusted before any popularity signal exists.
   * A project's own release blog is high; a broad tech news feed is lower.
   */
  quality: number;
}

export interface Popularity {
  hn_points?: number;
  hn_comments?: number;
  hn_id?: string;
  lobsters_score?: number;
  lobsters_comments?: number;
  devto_reactions?: number;
  devto_comments?: number;
  hf_upvotes?: number;
}

/** An item as a fetcher returns it, before any normalisation. */
export interface RawItem {
  url: string;
  title: string;
  description?: string;
  author?: string;
  publishedAt?: string;
  sourceId: string;
  sourceName: string;
  category: SourceCategory;
  quality: number;
  tags: string[];
  popularity?: Popularity;
}

export interface FetchResult {
  items: RawItem[];
  /** True when the server answered 304: nothing new, nothing parsed. */
  notModified?: boolean;
  etag?: string | null;
  lastModified?: string | null;
}

export interface FetchState {
  etag?: string | null;
  lastModified?: string | null;
}
