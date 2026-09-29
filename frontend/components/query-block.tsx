import type { UseQueryResult } from "@tanstack/react-query";
import { EmptyState } from "@/components/section";
import { Skeleton } from "@/components/ui/skeleton";

// Loading, failed-with-nothing-to-show, or data. When a refetch fails but earlier data exists,
// TanStack keeps it in `data`, so the last good view stays up and the page banner explains why.
export function QueryBlock<T>({
  query,
  rows = 3,
  children,
}: {
  query: UseQueryResult<T>;
  rows?: number;
  children: (data: T) => React.ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isPending && query.fetchStatus !== "idle") {
    return (
      <div className="space-y-3" aria-busy="true">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full motion-reduce:animate-none" />
        ))}
      </div>
    );
  }
  return <EmptyState>Not available right now</EmptyState>;
}
