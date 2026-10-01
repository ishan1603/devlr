import { Page, Skeleton } from "@/components/ui";

/**
 * Shown inside the app shell while a page's data loads, so navigating between
 * sections keeps the sidebar in place and never flashes a blank screen.
 */
export default function AppLoading() {
  return (
    <Page aria-busy="true" aria-label="Loading">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-3 h-9 w-64 max-w-full" />
      <Skeleton className="mt-3 h-4 w-96 max-w-full" />
      <div className="mt-10 grid gap-5 lg:grid-cols-2">
        <Skeleton className="h-44 rounded-xl" />
        <Skeleton className="h-44 rounded-xl" />
      </div>
      <Skeleton className="mt-5 h-64 rounded-xl" />
    </Page>
  );
}
