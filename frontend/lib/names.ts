import { humanize } from "@/lib/format";

// Turns API subjects like "station-tongi:DIESEL" or "event-2" into readable text.
export function describeSubject(subject: string | null | undefined, names: ReadonlyMap<string, string>): string {
  if (!subject) return "";
  const [id, fuel] = subject.split(":");
  const name = names.get(id) ?? id;
  return fuel ? `${name}, ${humanize(fuel).toLowerCase()}` : name;
}
