"""Frozen source scenarios. Conversion happens at the fixed-topology boundary."""
import copy
import json
import math
from pathlib import Path

MANIFESTS = json.loads((Path(__file__).parent/'scenarios'/'official.json').read_text())

def import_manifest(data):
    from training.world import STATIONS, DEPOTS, FUELS, ROUTES, SOURCE, DEST, LEAD, MAX, DAILY, NOISE, baseline, event
    def ordered(key, ids):
        rows = data[key]
        mapping = {r['id']:r for r in rows}
        if len(rows)!=len(ids) or set(mapping)!=set(ids): raise ValueError('unsupported '+key)
        return [mapping[i] for i in ids]
    def finite(x, positive=False):
        x=float(x)
        if not math.isfinite(x) or x<0 or (positive and x==0): raise ValueError('invalid manifest number')
        return x
    def indices(values, ids):
        try: return sorted({ids.index(v) for v in values})
        except ValueError as exc: raise ValueError('unknown event target') from exc
    regions=['region-dhaka','region-chattogram']
    rr=ordered('regions',regions);ss=ordered('stations',STATIONS);dd=ordered('depots',DEPOTS)
    routes=ordered('routes',ROUTES)
    if [r['demand_factor'] for r in rr]!=[1,1.08]: raise ValueError('unsupported region factors')
    if data['start_time']!='2026-01-01T00:00:00+00:00': raise ValueError('unsupported initial clock')
    for i,r in enumerate(routes):
        if (r['source_depot_id'],r['destination_station_id'],r['transit_ticks'],r['max_shipment'])!=(DEPOTS[SOURCE[i]],STATIONS[DEST[i]],LEAD[i],MAX[i]): raise ValueError('unsupported route topology')
    for i,s in enumerate(ss):
        p=data['demand_profiles'][s['demand_profile']]
        if s['demand_profile']!=['urban_high','industrial','highway','regional'][i] or [p['daily_liters'][f] for f in FUELS]!=DAILY[i] or p['noise']!=NOISE[i] or s['region_id']!=regions[i//2]: raise ValueError('unsupported demand profile')
    cfg=baseline()
    for entities,stock,capacity in [(ss,'stock','capacity'),(dd,'depot','depot_capacity')]:
        cfg[capacity]=[[finite(e['capacity'][f],True) for f in FUELS] for e in entities]
        cfg[stock]=[[finite(e['initial_inventory'][f]) for f in FUELS] for e in entities]
        if any(q>c for row,cap in zip(cfg[stock],cfg[capacity]) for q,c in zip(row,cap)): raise ValueError('inventory exceeds capacity')
    cfg['dispatch']=[finite(d['dispatch_capacity_per_tick'],True) for d in dd]
    cfg['supplies']=[]
    for s in data['supply_arrivals']:
        tick=s['arrival_tick']
        if not isinstance(tick,int) or tick<0: raise ValueError('invalid supply tick')
        cfg['supplies'].append(dict(Depot=indices([s['depot_id']],DEPOTS)[0],Fuel=indices([s['fuel_type']],FUELS)[0],Tick=tick,Quantity=finite(s['quantity']),Status='SCHEDULED'))
    cfg['events']=[]
    for e in data.get('preloaded_events',[]):
        kind=e['type'];p=e.get('parameters',{});start=e['start_tick'];duration=e['duration_ticks']
        if not isinstance(start,int) or not isinstance(duration,int) or start<0 or duration<=0: raise ValueError('invalid event time')
        kwargs={}
        if kind=='demand_spike':
            station_ids=p.get('station_ids',[]);region_ids=p.get('region_ids',[])
            indices(region_ids,regions);indices(station_ids,STATIONS)
            kwargs['Stations']=[i for i,s in enumerate(ss) if (not station_ids and not region_ids) or s['id'] in station_ids or s['region_id'] in region_ids]
            kwargs['Multiplier']=finite(p.get('multiplier',1.5),True)
        elif kind=='route_disruption': kwargs['Routes']=indices(p.get('route_ids',[]),ROUTES)
        elif kind=='station_outage': kwargs['Stations']=indices(p.get('station_ids',[]),STATIONS)
        elif kind=='depot_constraint': kwargs['Depots']=indices(p.get('depot_ids',[]),DEPOTS)
        elif kind in ('shipment_delay','supply_shortfall'):
            kwargs['Depots']=indices(p.get('depot_ids',[]),DEPOTS);kwargs['Fuels']=indices(p.get('fuel_types',[]),FUELS)
            if kind=='shipment_delay':
                delay=p.get('delay_ticks',2)
                if not isinstance(delay,int) or delay<0: raise ValueError('invalid delay')
                kwargs['Delay']=delay
            else: kwargs['Factor']=finite(p.get('factor',.5))
        else: raise ValueError('unsupported event')
        cfg['events'].append(event(kind,start,duration,**kwargs))
    cfg.update(seed=int(data['seed']),family=data['scenario_id'],manifest=data['scenario_id'],source_sha256=data.get('source_sha256'),synthetic=False)
    return cfg

def load_manifest(name):
    if name not in MANIFESTS: raise ValueError('unknown manifest: '+str(name))
    return import_manifest(copy.deepcopy(MANIFESTS[name]))
