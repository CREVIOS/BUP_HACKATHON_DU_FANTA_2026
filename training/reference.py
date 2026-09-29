"""Read-only observation plus explicit reset/step of a designated disposable reference."""
import argparse
import json
import urllib.request
from pathlib import Path
from training.world import World,baseline,event,STATIONS,DEPOTS,ROUTES,FUELS
from training.planner_bridge import PlannerBridge

class OfficialEnv:
    def __init__(self,base_url,allow_reset=False):self.url=base_url.rstrip('/');self.allow_reset=allow_reset
    def request(self,path,body=None):
        req=urllib.request.Request(self.url+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=15) as response:return json.load(response)
    def inject(self,e):
        params={}
        for key,names,out in [('Stations',STATIONS,'station_ids'),('Depots',DEPOTS,'depot_ids'),('Routes',ROUTES,'route_ids'),('Fuels',FUELS,'fuel_types')]:
            if key in e:params[out]=[names[i] for i in e[key]]
        for key,out in [('Multiplier','multiplier'),('Factor','factor'),('Delay','delay_ticks')]:
            if key in e:params[out]=e[key]
        return self.request('/admin/events',dict(type=e['Kind'],start_tick=e['Start'],duration_ticks=e['End']-e['Start'],parameters=params))
    def reset(self):
        if not self.allow_reset:raise PermissionError('explicit disposable-reference reset authorization required')
        self.request('/admin/pause',{});self.request('/admin/reset',{})
    def step(self,orders,tick):
        for i,a in enumerate(orders):
            self.request('/v1/allocations',dict(idempotency_key=f'rl-reference-{tick}-{i}',source_depot_id=DEPOTS[a['Depot']],destination_station_id=STATIONS[a['Station']],route_id=ROUTES[a['Route']],fuel_type=FUELS[a['Fuel']],quantity=a['Quantity']))
        return self.request('/admin/step',{})
    def inventories(self):
        stations={s['id']:s for s in self.request('/v1/stations')};depots={d['id']:d for d in self.request('/v1/depots')}
        return [[stations[s]['inventory'][f] for f in FUELS] for s in STATIONS],[[depots[d]['inventory'][f] for f in FUELS] for d in DEPOTS]

def replay(url,allow_reset,horizon,policy,crisis=True):
    api=OfficialEnv(url,allow_reset);api.reset();cfg=baseline()
    if crisis:
        cfg['events']=[event('demand_spike',8,16,Stations=[0,1],Multiplier=1.8),event('route_disruption',14,10,Routes=[0]),event('shipment_delay',10,1,Depots=[0],Delay=6),event('supply_shortfall',30,1,Depots=[1],Factor=.5),event('station_outage',45,8,Stations=[3])]
    for e in cfg['events']:api.inject(e)
    w=World(cfg,reference_noise=True);bridge=PlannerBridge();max_delta=0.
    try:
        for t in range(horizon):
            result=bridge.evaluate(w.snapshot(),w.history)
            a=0 if policy=='noop' else (9 if result['mask'][9] else next((i for i in (10,11,12,5,6,7,8,1,2,3,4) if result['mask'][i]),0))
            orders=result['plans'][a]['Shipments'] or []
            response=api.step(orders,t);w.advance(orders)
            if response['tick']!=w.tick:raise AssertionError(f'tick mismatch at {t}')
            stock,depot=api.inventories()
            delta=max(abs(x-y) for rows1,rows2 in [(stock,w.stock),(depot,w.depot)] for row1,row2 in zip(rows1,rows2) for x,y in zip(row1,row2))
            max_delta=max(max_delta,delta)
            if delta>.00101:raise AssertionError(f'inventory divergence tick {t}: {delta}; official={stock,depot}; offline={w.stock,w.depot}')
            if (t+1)%64==0:print(json.dumps(dict(progress=t+1,max_inventory_delta=max_delta)),flush=True)
        metrics=api.request('/v1/metrics');ours=w.metrics()
        for external,internal in [('served_demand_liters','served'),('unmet_demand_liters','unmet'),('allocation_failures','failures')]:
            if abs(metrics[external]-ours[internal])>.002:raise AssertionError(f'metric mismatch {external}')
        return dict(passed=True,horizon=horizon,policy=policy,crisis=crisis,max_inventory_delta=max_delta,official=metrics,offline=ours)
    finally:bridge.close()

def main():
    p=argparse.ArgumentParser();p.add_argument('--url',required=True);p.add_argument('--allow-reset',action='store_true');p.add_argument('--horizon',type=int,default=128);p.add_argument('--policy',choices=['noop','greedy'],default='greedy');p.add_argument('--no-crisis',action='store_true');p.add_argument('--output',required=True);args=p.parse_args()
    result=replay(args.url,args.allow_reset,args.horizon,args.policy,not args.no_crisis);path=Path(args.output);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
if __name__=='__main__':main()
