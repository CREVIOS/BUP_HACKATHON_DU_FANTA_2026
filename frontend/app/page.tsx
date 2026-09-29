import { Dashboard } from "@/components/dashboard";
import { FuelopsProvider } from "@/components/providers/fuelops-provider";

// ?mock=demo previews the UI on responses captured from the real API (no network calls).
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { mock } = await searchParams;
  const demo = mock === "demo";
  return (
    <FuelopsProvider key={demo ? "demo" : "live"} mock={demo}>
      <Dashboard scenario={demo ? "demo" : undefined} />
    </FuelopsProvider>
  );
}
