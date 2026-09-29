import { describe, expect, it } from "vitest";
import network from "@/lib/api/__fixtures__/network.json";
import { networkSchema } from "@/lib/api/schemas";
import { deriveNetworkView } from "@/lib/view";

const view = deriveNetworkView(networkSchema.parse(network));

describe("deriveNetworkView", () => {
  it("builds one row per depot and station with region names", () => {
    expect(view.depots).toHaveLength(network.depots.length);
    expect(view.stations).toHaveLength(network.stations.length);
    expect(view.stations[0].region).not.toMatch(/^region-/);
  });

  it("carries the projected risk and hours to stockout for stations only", () => {
    const station = view.stations.find((s) => Object.values(s.fuels).some((f) => typeof f?.hoursToStockout === "number"));
    expect(station).toBeDefined();
    expect(Object.values(view.depots[0].fuels).every((f) => f?.risk === undefined)).toBe(true);
  });

  it("resolves ids to names", () => {
    expect(view.names.get(network.depots[0].id)).toBe(network.depots[0].name);
  });
});
