// Generated from a real baseline snapshot (tick 0) so mock data has the exact backend shape.
import type { Snapshot } from "@/lib/types";

export const BASELINE: Snapshot = {
  "instance": {
    "tick": 0,
    "status": "PAUSED",
    "sim_time": "2026-01-01T00:00:00",
    "scenario_id": "baseline",
    "tick_minutes": 15
  },
  "regions": [
    {
      "id": "region-dhaka",
      "name": "Dhaka Division",
      "demand_factor": 1
    },
    {
      "id": "region-chattogram",
      "name": "Chattogram Division",
      "demand_factor": 1.08
    }
  ],
  "depots": [
    {
      "id": "depot-gazipur",
      "name": "Gazipur Depot",
      "status": "OPEN",
      "capacity": {
        "DIESEL": 90000,
        "OCTANE": 45000,
        "PETROL": 70000
      },
      "inventory": {
        "DIESEL": 60000,
        "OCTANE": 26000,
        "PETROL": 45000
      },
      "region_id": "region-dhaka",
      "dispatch_capacity_per_tick": 12000
    },
    {
      "id": "depot-patiya",
      "name": "Patiya Depot",
      "status": "OPEN",
      "capacity": {
        "DIESEL": 85000,
        "OCTANE": 40000,
        "PETROL": 65000
      },
      "inventory": {
        "DIESEL": 55000,
        "OCTANE": 24000,
        "PETROL": 42000
      },
      "region_id": "region-chattogram",
      "dispatch_capacity_per_tick": 11000
    }
  ],
  "stations": [
    {
      "id": "station-mirpur",
      "name": "Mirpur Fuel Station",
      "status": "OPEN",
      "capacity": {
        "DIESEL": 15000,
        "OCTANE": 9000,
        "PETROL": 14000
      },
      "inventory": {
        "DIESEL": 9000,
        "OCTANE": 5000,
        "PETROL": 9000
      },
      "region_id": "region-dhaka",
      "demand_profile": "urban_high",
      "demand_multiplier": 1
    },
    {
      "id": "station-tongi",
      "name": "Tongi Industrial Station",
      "status": "OPEN",
      "capacity": {
        "DIESEL": 18000,
        "OCTANE": 6000,
        "PETROL": 9000
      },
      "inventory": {
        "DIESEL": 11000,
        "OCTANE": 3500,
        "PETROL": 6000
      },
      "region_id": "region-dhaka",
      "demand_profile": "industrial",
      "demand_multiplier": 1
    },
    {
      "id": "station-karnaphuli",
      "name": "Karnaphuli Highway Station",
      "status": "OPEN",
      "capacity": {
        "DIESEL": 14000,
        "OCTANE": 9000,
        "PETROL": 15000
      },
      "inventory": {
        "DIESEL": 8500,
        "OCTANE": 5200,
        "PETROL": 9500
      },
      "region_id": "region-chattogram",
      "demand_profile": "highway",
      "demand_multiplier": 1
    },
    {
      "id": "station-coxsbazar",
      "name": "Cox's Bazar Regional Station",
      "status": "OPEN",
      "capacity": {
        "DIESEL": 12000,
        "OCTANE": 7000,
        "PETROL": 12000
      },
      "inventory": {
        "DIESEL": 7500,
        "OCTANE": 4200,
        "PETROL": 7500
      },
      "region_id": "region-chattogram",
      "demand_profile": "regional",
      "demand_multiplier": 1
    }
  ],
  "routes": [
    {
      "id": "route-gazipur-mirpur",
      "status": "AVAILABLE",
      "max_shipment": 7000,
      "transit_ticks": 2,
      "source_depot_id": "depot-gazipur",
      "destination_station_id": "station-mirpur"
    },
    {
      "id": "route-gazipur-tongi",
      "status": "AVAILABLE",
      "max_shipment": 6500,
      "transit_ticks": 2,
      "source_depot_id": "depot-gazipur",
      "destination_station_id": "station-tongi"
    },
    {
      "id": "route-patiya-karnaphuli",
      "status": "AVAILABLE",
      "max_shipment": 7000,
      "transit_ticks": 2,
      "source_depot_id": "depot-patiya",
      "destination_station_id": "station-karnaphuli"
    },
    {
      "id": "route-patiya-coxsbazar",
      "status": "AVAILABLE",
      "max_shipment": 6000,
      "transit_ticks": 3,
      "source_depot_id": "depot-patiya",
      "destination_station_id": "station-coxsbazar"
    },
    {
      "id": "route-gazipur-karnaphuli",
      "status": "AVAILABLE",
      "max_shipment": 5000,
      "transit_ticks": 4,
      "source_depot_id": "depot-gazipur",
      "destination_station_id": "station-karnaphuli"
    },
    {
      "id": "route-patiya-mirpur",
      "status": "AVAILABLE",
      "max_shipment": 5000,
      "transit_ticks": 4,
      "source_depot_id": "depot-patiya",
      "destination_station_id": "station-mirpur"
    }
  ],
  "events": [],
  "allocations": [],
  "supply_arrivals": [
    {
      "id": "supply-001",
      "status": "SCHEDULED",
      "depot_id": "depot-gazipur",
      "quantity": 18000,
      "fuel_type": "DIESEL",
      "actual_tick": null,
      "planned_tick": 12
    },
    {
      "id": "supply-003",
      "status": "SCHEDULED",
      "depot_id": "depot-patiya",
      "quantity": 16000,
      "fuel_type": "DIESEL",
      "actual_tick": null,
      "planned_tick": 14
    },
    {
      "id": "supply-002",
      "status": "SCHEDULED",
      "depot_id": "depot-gazipur",
      "quantity": 14000,
      "fuel_type": "PETROL",
      "actual_tick": null,
      "planned_tick": 16
    },
    {
      "id": "supply-004",
      "status": "SCHEDULED",
      "depot_id": "depot-patiya",
      "quantity": 9000,
      "fuel_type": "OCTANE",
      "actual_tick": null,
      "planned_tick": 20
    },
    {
      "id": "supply-101",
      "status": "SCHEDULED",
      "depot_id": "depot-gazipur",
      "quantity": 12000,
      "fuel_type": "DIESEL",
      "actual_tick": null,
      "planned_tick": 64
    },
    {
      "id": "supply-102",
      "status": "SCHEDULED",
      "depot_id": "depot-gazipur",
      "quantity": 10000,
      "fuel_type": "PETROL",
      "actual_tick": null,
      "planned_tick": 68
    }
  ],
  "metrics": {
    "service_level": 1,
    "unmet_demand_liters": 0,
    "allocation_failures": 0
  }
};
