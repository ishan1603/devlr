import { fetchRss } from "@/lib/sources/fetchers/rss";
import {
  fetchDevto,
  fetchHackerNews,
  fetchHfPapers,
  fetchLobsters,
} from "@/lib/sources/fetchers/aggregators";
import type { FetchResult, FetchState, SourceDef } from "@/lib/sources/types";

/** One entry point per source kind, so ingestion never switches on kind itself. */
export function fetchSource(source: SourceDef, state: FetchState = {}): Promise<FetchResult> {
  switch (source.kind) {
    case "rss":
      return fetchRss(source, state);
    case "hn":
      return fetchHackerNews(source);
    case "lobsters":
      return fetchLobsters(source);
    case "devto":
      return fetchDevto(source);
    case "hf_papers":
      return fetchHfPapers(source);
  }
}
