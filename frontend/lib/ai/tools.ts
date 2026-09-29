import { tool } from "ai";
import { z } from "zod";
import { lowStock, networkFacts, type StockEntry } from "@/lib/ai/facts";
import { allocationSummaries, eventSummaries, routeSummaries, stockFor } from "@/lib/ai/queries";
import type { LoadedState } from "@/lib/ai/quality";

const pickStock = ({ name, kind, fuel, inventory, capacity, percent }: StockEntry) => ({
  name,
  kind,
  fuel,
  inventory,
  capacity,
  percent,
});

// Read-only on purpose: the assistant explains the network, it never changes it (brief section 24).
// `load` is called per tool run so each answer uses the freshest snapshot.
export function createTools(load: () => Promise<LoadedState>) {
  return {
    getOverview: tool({
      description:
        "Network summary: tick, run state, service level, unmet demand, disrupted routes, outages, active events, delayed supply, allocation counts.",
      inputSchema: z.object({}),
      execute: async () => {
        const { snapshot, quality } = await load();
        return networkFacts(snapshot, quality);
      },
    }),
    getLowStock: tool({
      description: "Depot and station fuel levels at or below a percentage of capacity, emptiest first.",
      inputSchema: z.object({
        maxPercent: z.number().int().min(1).max(100).default(40).describe("Upper bound, percent of capacity"),
      }),
      execute: async ({ maxPercent }) => ({
        maxPercent,
        entries: lowStock((await load()).snapshot, maxPercent).slice(0, 12).map(pickStock),
      }),
    }),
    getStock: tool({
      description: "All fuel levels for one depot or station, by id (for example station-mirpur).",
      inputSchema: z.object({ id: z.string().min(1).max(80) }),
      execute: async ({ id }) => ({ id, entries: stockFor((await load()).snapshot, id).map(pickStock) }),
    }),
    getRoutes: tool({
      description: "Transport routes with status, transit time in minutes and maximum shipment in litres.",
      inputSchema: z.object({ status: z.enum(["AVAILABLE", "DISRUPTED"]).optional() }),
      execute: async ({ status }) => ({ routes: routeSummaries((await load()).snapshot, status) }),
    }),
    getEvents: tool({
      description: "Simulator events: disruptions, demand spikes, delays, with their tick windows and status.",
      inputSchema: z.object({}),
      execute: async () => ({ events: eventSummaries((await load()).snapshot) }),
    }),
    getAllocations: tool({
      description: "Most recent fuel allocations, newest first, optionally filtered by status.",
      inputSchema: z.object({
        status: z.enum(["PENDING", "IN_TRANSIT", "ARRIVED", "FAILED", "CANCELLED"]).optional(),
        limit: z.number().int().min(1).max(20).default(10),
      }),
      execute: async ({ status, limit }) => ({ allocations: allocationSummaries((await load()).snapshot, status, limit) }),
    }),
  };
}

export type FuelopsTools = ReturnType<typeof createTools>;
