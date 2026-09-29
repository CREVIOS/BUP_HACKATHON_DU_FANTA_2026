"""Contract probes; only targets the disposable audit container on port 18013."""
import json
import time
import urllib.request
import urllib.error
from pathlib import Path

URL = 'http://127.0.0.1:18013'
results = []

def req(path, body=None):
    request = urllib.request.Request(URL+path, data=None if body is None else json.dumps(body).encode(), headers={'Content-Type':'application/json'})
    try:
        response = urllib.request.urlopen(request, timeout=10)
    except urllib.error.HTTPError as e:
        response = e
    with response:
        raw = response.read().decode()
        try: data = json.loads(raw)
        except ValueError: data = raw
        return response.status, data, dict(response.headers)

def get(path):
    status, data, _ = req(path)
    assert status == 200, (path,status,data)
    return data

def post(path, body=None):
    status,data,_ = req(path, {} if body is None else body)
    assert status in (200,201), (path,status,data)
    return data

def check(name, condition, detail=None):
    row = dict(name=name, confirmed=bool(condition), detail=detail)
    results.append(row); print(json.dumps(row),flush=True)
    assert condition, row

def reset(): post('/admin/reset')
def step(n=1):
    for _ in range(n): post('/admin/step')
def event(kind, start=0, duration=1, **params):
    return post('/admin/events',dict(type=kind,start_tick=start,duration_ticks=duration,parameters=params))
def fault(kind, **params):
    return post('/admin/faults',dict(type=kind,duration_seconds=30,parameters=params))
def order(key='a', quantity=1000, **changes):
    return dict(idempotency_key=key,source_depot_id='depot-gazipur',destination_station_id='station-mirpur',route_id='route-gazipur-mirpur',fuel_type='DIESEL',quantity=quantity,**changes)

initial = get('/v1/instance')
check('startup honors TICK_MINUTES=30',initial['tick_minutes']==30)
reset()
check('BUG reset loses TICK_MINUTES=30',get('/v1/instance')['tick_minutes']==15)
for path in ['/','/docs','/redoc','/openapi.json','/admin','/admin/stats','/admin/audit','/admin/faults','/admin/events','/v1/health','/v1/instance','/v1/regions','/v1/depots','/v1/stations','/v1/routes','/v1/supply-arrivals','/v1/events','/v1/allocations','/v1/demand-history','/v1/metrics']:
    check('GET '+path,req(path)[0]==200)
check('topology', [len(get('/v1/'+x)) for x in ('regions','depots','stations','routes','supply-arrivals')]==[2,2,4,6,22])
check('unknown entity 404',req('/v1/stations/missing')[0]==404)
check('quantity zero rejected',req('/v1/allocations',order(quantity=0))[0]==422)
check('route limit rejected',req('/v1/allocations',order(quantity=7001))[1]['detail']['code']=='ROUTE_CAPACITY_EXCEEDED')
check('station headroom rejected',req('/v1/allocations',order(quantity=6001))[1]['detail']['code']=='DESTINATION_CAPACITY_EXCEEDED')
a=post('/v1/allocations',order())
retry=req('/v1/allocations',order())
check('exact retry returns 201 same id',retry[0]==201 and retry[1]['id']==a['id'])
check('retry debits exactly once',get('/v1/depots/depot-gazipur')['inventory']['DIESEL']==59000)
check('key mismatch rejected',req('/v1/allocations',order(quantity=999))[1]['detail']['code']=='IDEMPOTENCY_KEY_MISMATCH')
post('/v1/allocations/'+str(a['id'])+'/cancel')
check('cancel refunds once',get('/v1/depots/depot-gazipur')['inventory']['DIESEL']==60000 and req('/v1/allocations/'+str(a['id'])+'/cancel',{})[0]==409)
check('cancel retains idempotency key',post('/v1/allocations',order())['status']=='CANCELLED')
reset(); post('/v1/allocations',order()); step()
a=get('/v1/allocations')[0]
check('departure tick and ETA',a['departure_tick']==0 and a['expected_arrival_tick']==2 and a['status']=='IN_TRANSIT')
step(2); a=get('/v1/allocations')[0]
check('arrival tick',a['actual_arrival_tick']==2 and a['status']=='ARRIVED')
check('demand rows 12 per tick',len(get('/v1/demand-history'))==36)
check('demand limit minimum one',len(get('/v1/demand-history?limit=0'))==1)
state=[get('/v1/stations'),get('/v1/metrics')]
reset(); post('/v1/allocations',order()); step(3)
check('replay deterministic',state==[get('/v1/stations'),get('/v1/metrics')])

reset(); post('/v1/allocations',order(quantity=6000)); post('/v1/allocations',order('b',6000))
check('BUG inbound headroom is not reserved',len(get('/v1/allocations'))==2)
check('dispatch capacity enforced',req('/v1/allocations',order('c',1))[1]['detail']['code']=='DISPATCH_CAPACITY_EXCEEDED')
step(3)
received=sum(x['metadata_json']['received'] for x in get('/admin/audit?limit=100') if x['action']=='allocation.arrived')
check('arrival overflow silently discarded',received<12000,dict(sent=12000,received=received))

reset(); event('route_disruption',route_ids=['route-gazipur-mirpur']); post('/v1/allocations',order()); step()
check('departure failure consumes fuel without refund',get('/v1/allocations')[0]['status']=='FAILED' and get('/v1/depots/depot-gazipur')['inventory']['DIESEL']==59000)
check('active route rejects new orders',req('/v1/allocations',order('b'))[1]['detail']['code']=='ROUTE_DISRUPTED')
step(); check('duration 1 includes ticks 0 and 1',get('/v1/events')[0]['status']=='RESOLVED' and get('/v1/instance')['tick']==2)
reset(); event('route_disruption'); event('station_outage'); event('depot_constraint'); step()
check('BUG empty entity filters do not mean all',all(x['status']=='AVAILABLE' for x in get('/v1/routes')) and all(x['status']=='OPEN' for x in get('/v1/stations')) and all(x['status']=='OPEN' for x in get('/v1/depots')))
reset(); event('depot_constraint',duration=4,depot_ids=['depot-gazipur']); step()
d=get('/v1/depots/depot-gazipur')
check('depot constraint label only',d['status']=='CONSTRAINED' and d['dispatch_capacity_per_tick']==12000 and req('/v1/allocations',order())[0]==201)
reset(); event('route_disruption',duration=1,route_ids=['route-gazipur-mirpur']); event('route_disruption',duration=5,route_ids=['route-gazipur-mirpur']); step(2)
check('BUG overlapping disruption clears early',get('/v1/routes')[0]['status']=='AVAILABLE' and get('/v1/events')[0]['status']=='ACTIVE')
reset(); event('station_outage',station_ids=['station-mirpur']); step()
rows=get('/v1/demand-history?station_id=station-mirpur')
check('outage demand wholly unmet',all(x['served_liters']==0 and x['unmet_liters']==x['demand_liters'] for x in rows))
reset(); event('demand_spike',region_ids=['region-dhaka'],multiplier=2); step()
check('region scoped demand multiplier',[s['demand_multiplier'] for s in get('/v1/stations')]==[2,2,1,1])
reset(); event('shipment_delay',delay_ticks=8,depot_ids=['depot-gazipur']); event('supply_shortfall',factor=.5,depot_ids=['depot-gazipur']); step()
s=next(x for x in get('/v1/supply-arrivals') if x['id']=='supply-001')
check('delay then shortfall apply',s['planned_tick']==20 and s['quantity']==9000 and s['status']=='DELAYED')
event('shipment_delay',start=1,delay_ticks=8,depot_ids=['depot-gazipur']); step()
s=next(x for x in get('/v1/supply-arrivals') if x['id']=='supply-001')
check('already delayed supply not delayed again',s['planned_tick']==20)

reset(); fault('unavailable')
check('unavailable and bypass',req('/v1/stations')[0]==503 and req('/v1/health')[0]==200 and req('/admin/stats')[0]==200)
post('/admin/faults/clear'); fault('error_rate',rate=1)
check('error rate one always rejects',req('/v1/stations')[0]==503)
post('/admin/faults/clear'); fault('latency',delay_ms=150)
start=time.monotonic(); get('/v1/stations'); elapsed=time.monotonic()-start
check('latency injected',elapsed>=.15,elapsed)
post('/admin/faults/clear'); fault('stale_data')
check('stale header exists',req('/v1/stations')[2].get('x-simulator-stale')=='true')
with urllib.request.urlopen(URL+'/v1/stream',timeout=3) as stream:
    check('BUG stale header also on SSE',stream.headers.get('X-Simulator-Stale')=='true')
    check('SSE connected comment',stream.readline().decode().strip()==': connected')
    stream.readline()
    post('/v1/allocations',order()); step(3)
    names=[]
    for _ in range(5):
        names.append(stream.readline().decode().strip()); stream.readline(); stream.readline()
    check('SSE lacks departed and arrived notifications',names.count('event: allocation.status_changed')==1 and names.count('event: simulation.tick')==3,names)
    fault('stream_disconnect'); post('/admin/step')
    check('existing SSE connection not disconnected',stream.readline().decode().strip()=='event: simulation.tick')
check('stream fault rejects new connections',req('/v1/stream')[0]==503)
post('/admin/faults/clear'); reset()
event('demand_spike',multiplier=0); step()
status,body,_=req('/admin/step',{})
check('BUG zero multiplier accepted then crashes resolve',status==500)
reset(); post('/admin/run'); time.sleep(.5); post('/admin/pause')
check('background run progresses',get('/v1/instance')['tick']>0)
check('toggle twice returns PAUSED',post('/admin/toggle')['status']=='RUNNING' and post('/admin/toggle')['status']=='PAUSED')
reset()
Path('/private/tmp/fuel-reverse-audit-results.json').write_text(json.dumps(results,indent=2))
print('CONFIRMED',len(results),'checks',flush=True)
