import type { Brief, BriefChanges, BriefItem, Severity } from "@/lib/ai/brief";

const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };
const MAX_KEYS = 20; // scenarios remembered; older ones are dropped

// What makes two briefings "the same": the status and which problems are open at which severity. Figures
// (litres, percentages) move every tick and do not count, so a steady network keeps one signature.
export function briefSignature(brief: Pick<Brief, "status" | "items">): string {
  const items = brief.items.map((i) => `${i.id}:${i.severity}`).sort();
  return `${brief.status}|${items.join(",")}`;
}

type Seen = Pick<BriefItem, "id" | "title" | "severity">;

export function diffItems(before: readonly Seen[], after: readonly Seen[]): Omit<BriefChanges, "sinceTick"> {
  const was = new Map(before.map((i) => [i.id, i]));
  const now = new Set(after.map((i) => i.id));
  return {
    added: after.filter((i) => !was.has(i.id)).map((i) => i.title),
    resolved: before.filter((i) => !now.has(i.id)).map((i) => i.title),
    worse: after.filter((i) => {
      const old = was.get(i.id);
      return old !== undefined && RANK[i.severity] > RANK[old.severity];
    }).map((i) => i.title),
  };
}

interface Entry {
  signature: string;
  items: Seen[];
  tick: number;
  changes?: BriefChanges;
}

// Remembers the last briefing per scenario so each new one can say what changed. While nothing
// material changes, it keeps reporting the change that led to the current state.
export function createBriefHistory() {
  const entries = new Map<string, Entry>();
  return {
    track(key: string, brief: Brief): BriefChanges | undefined {
      const signature = briefSignature(brief);
      const items = brief.items.map(({ id, title, severity }) => ({ id, title, severity }));
      const previous = entries.get(key);
      if (previous?.signature === signature) return previous.changes;
      const changes = previous ? { sinceTick: previous.tick, ...diffItems(previous.items, items) } : undefined;
      entries.delete(key);
      entries.set(key, { signature, items, tick: brief.tick, changes });
      if (entries.size > MAX_KEYS) entries.delete(entries.keys().next().value as string);
      return changes;
    },
  };
}
