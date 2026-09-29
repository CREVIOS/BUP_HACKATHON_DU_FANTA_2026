import { Dashboard } from "@/components/dashboard";
import { FuelopsProvider } from "@/components/providers/fuelops-provider";

export default function Home() {
  return (
    <FuelopsProvider>
      <Dashboard />
    </FuelopsProvider>
  );
}
