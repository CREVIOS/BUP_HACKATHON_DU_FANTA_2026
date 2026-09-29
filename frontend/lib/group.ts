export interface Group<T> {
  key: string;
  items: T[];
}

// Groups rows by key in order of first appearance, keeping each group's rows in their original order.
export function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Group<T>[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].map(([key, items]) => ({ key, items }));
}
