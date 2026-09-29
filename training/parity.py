"""Run inside the unmodified official runtime with DATABASE_URL=sqlite://.

Imports official source and API handlers, but uses only a private in-memory DB.
No HTTP instance data or source files are modified.
"""
import asyncio
import json
from pathlib import Path
from training.world import World, load_manifest, STATIONS, DEPOTS, FUELS, ROUTES
from training.planner_bridge import PlannerBridge

async def main():
    from app.db import Base, engine, SessionLocal
    from app.scenario import reset_from_scenario
    from app.engine import tick_once
    from app.main import create_allocation
    from app.schemas import AllocationCreate
    from app.models import Station, Depot, Allocation, SupplyArrival, DemandObservation
    Base.metadata.create_all(engine)
    results=[];bridge=PlannerBridge()
    try:
        with SessionLocal() as db:
            for name in ('baseline','demand_spike','supply_disruption','final_combined'):
                raw=reset_from_scenario(db,'/app/scenarios/'+name+'.yaml')
                cfg=load_manifest(name);w=World(cfg,seed=cfg['seed'],reference_noise=True)
                for t in range(576):
                    result=bridge.evaluate(w.snapshot(),w.history)
                    orders=result['plans'][result['baseline_action']]['Shipments'] or []
                    for i,a in enumerate(orders):
                        try:
                            await create_allocation(AllocationCreate(idempotency_key=f'{t}-{i}',source_depot_id=DEPOTS[a['Depot']],destination_station_id=STATIONS[a['Station']],route_id=ROUTES[a['Route']],fuel_type=FUELS[a['Fuel']],quantity=a['Quantity']),db)
                        except Exception:
                            print(json.dumps(dict(scenario=name,tick=t,index=i,orders=orders,dispatch=w.dispatch,accepted=[(x.quantity,x.created_tick,x.status) for x in db.query(Allocation).filter_by(created_tick=t).all()])),flush=True)
                            raise
                    tick_once(db,raw);w.advance(orders)
                    stock=[[db.get(Station,s).inventory[f] for f in FUELS] for s in STATIONS]
                    depots=[[db.get(Depot,d).inventory[f] for f in FUELS] for d in DEPOTS]
                    assert stock==w.stock and depots==w.depot,(name,t,'inventory')
                    assert [db.get(Station,s).demand_multiplier for s in STATIONS]==w.multiplier,(name,t,'multiplier')
                    for row in db.query(DemandObservation).filter_by(tick=t).all():
                        assert row.demand_liters==w.last_demand[STATIONS.index(row.station_id)][FUELS.index(row.fuel_type)],(name,t,'demand')
                    official=[(a.status,a.quantity,a.expected_arrival_tick or 0) for a in db.query(Allocation).filter(Allocation.status.in_(['PENDING','IN_TRANSIT'])).order_by(Allocation.id).all()]
                    offline=[(a['Status'],a['Quantity'],a['ETA']) for a in w.allocations if a['Status'] in ('PENDING','IN_TRANSIT')]
                    assert official==offline,(name,t,'active allocations')
                    supplied=db.query(SupplyArrival).order_by(SupplyArrival.id).all()
                    assert sorted((a.depot_id,a.fuel_type,a.planned_tick,a.quantity,a.status) for a in supplied)==sorted((DEPOTS[a['Depot']],FUELS[a['Fuel']],a['Tick'],a['Quantity'],a['Status']) for a in w.supplies),(name,t,'supplies')
                result=dict(scenario=name,passed=True,horizon=576,max_inventory_difference=0,metrics=w.metrics());results.append(result);print(json.dumps(result),flush=True)
    finally:bridge.close()
    return results

if __name__=='__main__': asyncio.run(main())
