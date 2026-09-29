"""Exercise every supplied scenario in an isolated in-memory database."""
import json
from pathlib import Path
from sqlalchemy import func
from app.db import Base, engine, SessionLocal
from app.scenario import reset_from_scenario
from app.engine import tick_once
from app.models import Station, Depot, DemandObservation, DomainEvent, SimulationInstance

Base.metadata.create_all(engine)
with SessionLocal() as db:
    for path in sorted(Path('/app/scenarios').glob('*.yaml')):
        scenario = reset_from_scenario(db,str(path))
        for _ in range(576):
            tick_once(db,scenario)
            for model in (Station,Depot):
                for entity in db.query(model).all():
                    assert all(0 <= v <= entity.capacity[k] for k,v in entity.inventory.items())
        served = db.query(func.sum(DemandObservation.served_liters)).scalar()
        unmet = db.query(func.sum(DemandObservation.unmet_liters)).scalar()
        assert db.query(DemandObservation).count() == 576*12
        assert all(e.status == 'RESOLVED' for e in db.query(DomainEvent).all())
        print(json.dumps(dict(scenario=path.name,ticks=db.get(SimulationInstance,1).tick,seed=scenario['seed'],supplies=len(scenario['supply_arrivals']),demand_rows=6912,served=round(served,3),unmet=round(unmet,3),service_level=served/(served+unmet),policy='no allocations',bounded_inventory=True)),flush=True)
