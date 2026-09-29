import { project } from "@/lib/map/bangladesh";

export type LabelSide = "left" | "right";

// The simulator's sites are named after real places. Positions are those places (approximate),
// nudged apart where they would sit on top of each other at country scale (Mirpur, Tongi and
// Gazipur are within about 20 km). Labels near the east coast sit on the left so they stay on screen.
const SITES: Record<string, { lon: number; lat: number; side: LabelSide }> = {
  "depot-gazipur": { lon: 90.42, lat: 24.12, side: "left" },
  "station-tongi": { lon: 90.66, lat: 23.9, side: "right" },
  "station-mirpur": { lon: 90.2, lat: 23.76, side: "left" },
  "depot-patiya": { lon: 92.04, lat: 22.16, side: "left" },
  "station-karnaphuli": { lon: 91.72, lat: 22.58, side: "left" },
  "station-coxsbazar": { lon: 92.0, lat: 21.45, side: "left" },
};

// Unknown sites (another scenario) go around their division's centre.
const REGION_CENTRES: Record<string, { lon: number; lat: number }> = {
  "region-dhaka": { lon: 90.4, lat: 23.8 },
  "region-chattogram": { lon: 91.83, lat: 22.35 },
};
const COUNTRY_CENTRE = { lon: 90.35, lat: 23.7 };

export interface SitePosition {
  x: number;
  y: number;
  side: LabelSide;
}

export function sitePosition(id: string, regionId: string, index: number): SitePosition {
  const known = SITES[id];
  if (known) return { ...project(known.lon, known.lat), side: known.side };
  const centre = REGION_CENTRES[regionId] ?? COUNTRY_CENTRE;
  const angle = (index * 2 * Math.PI) / 6;
  return { ...project(centre.lon + 0.25 * Math.cos(angle), centre.lat + 0.2 * Math.sin(angle)), side: index % 2 ? "left" : "right" };
}

// geoBoundaries division id for an API region id ("region-chattogram" -> "chattogram").
export const divisionOf = (regionId: string): string => regionId.replace(/^region-/, "");
