"""Offline BUP transition model. No source files in the official image are modified."""
import copy
import hashlib
import math
import random
from training.scenarios import load_manifest, import_manifest

STATIONS=['station-mirpur','station-tongi','station-karnaphuli','station-coxsbazar']
DEPOTS=['depot-gazipur','depot-patiya']
FUELS=['DIESEL','PETROL','OCTANE']
ROUTES=['route-gazipur-mirpur','route-gazipur-tongi','route-patiya-karnaphuli','route-patiya-coxsbazar','route-gazipur-karnaphuli','route-patiya-mirpur']
SOURCE=[0,0,1,1,0,1]; DEST=[0,1,2,3,2,0]; LEAD=[2,2,2,3,4,4]; MAX=[7000,6500,7000,6000,5000,5000]
DAILY=[[8500,10500,5600],[14000,4500,2200],[10500,11000,6200],[7200,7600,3600]]
NOISE=[.10,.08,.12,.10]

def event(kind,start,duration,**kwargs):
    return dict(Kind=kind,Start=start,End=start+duration,Status='SCHEDULED',Reveal=kwargs.pop('Reveal',0),**kwargs)

def baseline():
    supplies=[dict(Depot=d,Fuel=f,Tick=t,Quantity=q,Status='SCHEDULED') for d,f,t,q in [(0,0,12,18000),(0,1,16,14000),(1,0,14,16000),(1,2,20,9000)]]
    for t in (64,128,192):
        supplies.extend(dict(Depot=d,Fuel=f,Tick=t+offset,Quantity=q,Status='SCHEDULED') for d,f,offset,q in [(0,0,0,12000),(0,1,4,10000),(0,2,8,7000),(1,0,12,10000),(1,1,16,8000),(1,2,20,6000)])
    return dict(stock=[[9000,9000,5000],[11000,6000,3500],[8500,9500,5200],[7500,7500,4200]],capacity=[[15000,14000,9000],[18000,9000,6000],[14000,15000,9000],[12000,12000,7000]],depot=[[60000,45000,26000],[55000,42000,24000]],depot_capacity=[[90000,70000,45000],[85000,65000,40000]],dispatch=[12000,11000],supplies=supplies,events=[])

def hour_factor(hour,s):
    if s==1:return 1.55 if 6<=hour<18 else .45
    if s==2:return 1.35 if 6<=hour<10 or 16<=hour<21 else .75
    if s==0:return 1.45 if 7<=hour<10 or 16<=hour<21 else .70
    return 1.25 if 7<=hour<21 else .65

def scenario(seed, family=None, synthetic=True):
    rng=random.Random(seed);cfg=baseline()
    if family in ('baseline','demand_spike','supply_disruption','final_combined'):
        return load_manifest(family)
    if family is None and rng.random()<.5:
        cfg=load_manifest(rng.choice(['baseline','demand_spike','supply_disruption','final_combined']))
        return cfg
    if rng.random()<.5:cfg['supplies']=cfg['supplies'][:4]
    family=family or rng.choices(['normal','spike','route','supply','combined','outage'],[20,20,20,15,15,10])[0]
    if synthetic and rng.random()<.7:
        cfg['stock']=[[round(c*rng.uniform(.1,.9),3) for c in row] for row in cfg['capacity']]
        cfg['depot']=[[round(c*rng.uniform(.1,.7),3) for c in row] for row in cfg['depot_capacity']]
    start=rng.randint(8,100);duration=rng.randint(4,48);reveal=0 if rng.random()<.6 else start
    ev=[]
    if family in ('spike','combined'):
        ev.append(event('demand_spike',start,duration,Reveal=reveal,Stations=[rng.randrange(4)],Multiplier=rng.uniform(1.2,3)))
    if family in ('route','combined'):
        ev.append(event('route_disruption',start,duration,Reveal=reveal,Routes=[rng.randrange(6)]))
    if family in ('supply','combined'):
        ev.append(event('shipment_delay',max(0,start-8),1,Depots=[rng.randrange(2)],Delay=rng.randint(2,32)))
        ev.append(event('supply_shortfall',max(0,start-8),1,Depots=[rng.randrange(2)],Factor=rng.uniform(.2,.9)))
    if family=='outage':ev.append(event('station_outage',start,duration,Reveal=reveal,Stations=[rng.randrange(4)]))
    cfg.update(events=ev,family=family,synthetic=synthetic)
    return cfg

class World:
    def __init__(self,cfg,seed=12345,reference_noise=False):
        cfg=copy.deepcopy(cfg)
        self.stock=cfg['stock'];self.capacity=cfg['capacity'];self.depot=cfg['depot'];self.depot_capacity=cfg['depot_capacity'];self.dispatch=cfg['dispatch']
        self.supplies=cfg['supplies'];self.events=cfg['events'];self.seed=seed;self.rng=random.Random(seed);self.reference_noise=reference_noise
        self.tick=0;self.multiplier=[1.]*4;self.station_open=[True]*4;self.depot_open=[True]*2;self.route_open=[True]*6
        self.allocations=[];self.next_id=1;self.history=[];self.last_demand=[]
        self.served=self.unmet=self.lost=self.offered=self.requests=self.liter_transit=self.failures=0.
        self.initial=sum(map(sum,self.stock))+sum(map(sum,self.depot));self.last_components={}

    def snapshot(self):
        return dict(Epoch=1,Tick=self.tick,Minute=self.tick*15%1440,TickMinutes=15,Stale=False,Stock=self.stock,Capacity=self.capacity,Depot=self.depot,DepotCapacity=self.depot_capacity,Dispatch=self.dispatch,StationOpen=self.station_open,DepotOpen=self.depot_open,RouteOpen=self.route_open,Multiplier=self.multiplier,Allocations=[a for a in self.allocations if a['Status'] in ('PENDING','IN_TRANSIT')],Supplies=self.supplies,Events=[e for e in self.events if e.get('Reveal',0)<=self.tick])

    def _event(self,e,resolve=False):
        kind=e['Kind'];stations=e.get('Stations',[])
        if kind=='demand_spike':
            for s in stations or range(4):self.multiplier[s]=max(.01,self.multiplier[s]/e['Multiplier']) if resolve else self.multiplier[s]*e['Multiplier']
        elif kind=='route_disruption':
            for r in e.get('Routes',[]):self.route_open[r]=resolve
        elif kind=='station_outage':
            for s in stations:self.station_open[s]=resolve
        elif kind=='depot_constraint':pass  # Official CONSTRAINED changes label, not dispatch eligibility.
        elif not resolve and kind in ('shipment_delay','supply_shortfall'):
            for a in self.supplies:
                if e.get('Depots') and a['Depot'] not in e['Depots']:continue
                if e.get('Fuels') and a['Fuel'] not in e['Fuels']:continue
                if kind=='shipment_delay' and a['Status']=='SCHEDULED':a['Tick']+=e.get('Delay',2);a['Status']='DELAYED'
                if kind=='supply_shortfall' and a['Status'] in ('SCHEDULED','DELAYED'):a['Quantity']*=e.get('Factor',.5)

    def _orders(self,orders):
        inventory=copy.deepcopy(self.depot);dispatch=self.dispatch.copy()
        # Reference world enforces official API rules, not the stronger candidate shield.
        for a in orders:
            d,s,r,f,q=(a[k] for k in ('Depot','Station','Route','Fuel','Quantity'))
            if not (isinstance(d,int) and isinstance(s,int) and isinstance(r,int) and isinstance(f,int) and 0<=d<2 and 0<=s<4 and 0<=r<6 and 0<=f<3 and math.isfinite(q) and 0<q<=MAX[r]):raise ValueError('invalid order')
            if SOURCE[r]!=d or DEST[r]!=s or not self.station_open[s] or not self.depot_open[d] or not self.route_open[r]:raise ValueError('closed or mismatched route')
            if q>inventory[d][f]+1e-8 or q>dispatch[d]+1e-8 or q+self.stock[s][f]>self.capacity[s][f]+1e-8:raise ValueError('capacity exceeded')
            inventory[d][f]=round(inventory[d][f]-q,3);dispatch[d]-=q
        self.depot=inventory
        for order in orders:
            a=dict(order,Key='w-'+str(self.next_id),Created=self.tick,ETA=0,Status='PENDING');self.next_id+=1;self.allocations.append(a)
            self.requests+=1;self.liter_transit+=a['Quantity']*LEAD[a['Route']]

    def advance(self,orders,demand=None):
        self._orders(orders)
        old_unmet,old_lost=self.unmet,self.lost
        self.allocations=[a for a in self.allocations if a['Status'] in ('PENDING','IN_TRANSIT')]
        for e in self.events:
            if e['Status']=='SCHEDULED' and e['Start']<=self.tick:e['Status']='ACTIVE';self._event(e)
        for a in self.supplies:
            if a['Status'] in ('SCHEDULED','DELAYED') and a['Tick']<=self.tick:
                d,f,q=a['Depot'],a['Fuel'],a['Quantity'];added=min(q,max(0,self.depot_capacity[d][f]-self.depot[d][f]));self.depot[d][f]=round(self.depot[d][f]+added,3);self.offered+=q;self.lost+=q-added;a['Status']='ARRIVED'
        for a in self.allocations:
            if a['Status']=='PENDING':
                if not self.route_open[a['Route']]:a['Status']='FAILED';self.failures+=1;self.lost+=a['Quantity']
                else:a['Status']='IN_TRANSIT';a['ETA']=self.tick+LEAD[a['Route']]
        for a in self.allocations:
            if a['Status']=='IN_TRANSIT' and a['ETA']<=self.tick:
                s,f,q=a['Station'],a['Fuel'],a['Quantity'];received=min(q,max(0,self.capacity[s][f]-self.stock[s][f]));self.stock[s][f]=round(self.stock[s][f]+received,3);self.lost+=q-received;a['Status']='ARRIVED'
        self.last_demand=[]
        for s in range(4):
            ds=[]
            for f in range(3):
                if demand is None:
                    rng=self.rng
                    if self.reference_noise:
                        raw=f'{self.seed}:{self.tick}:{STATIONS[s]}:demand:{FUELS[f]}'.encode();rng=random.Random(int.from_bytes(hashlib.sha256(raw).digest()[:8],'big'))
                    q=DAILY[s][f]/96*hour_factor(self.tick*15%1440//60,s)*(1 if s<2 else 1.08)*self.multiplier[s]*(1+rng.uniform(-NOISE[s],NOISE[s]))
                else:q=demand[s][f]
                ds.append(round(q,3));served=min(self.stock[s][f],q) if self.station_open[s] else 0;unmet=q-served
                self.stock[s][f]=round(max(0,self.stock[s][f]-served),3);self.served+=round(served,3);self.unmet+=round(unmet,3)
                self.history.append(dict(Station=s,Fuel=f,Tick=self.tick,Demand=round(q,3),Served=round(served,3),Unmet=round(unmet,3)))
            self.last_demand.append(ds)
        self.history=self.history[-96:]
        for e in self.events:
            if e['Status']=='ACTIVE' and e['End']<=self.tick:self._event(e,True);e['Status']='RESOLVED'
        self.tick+=1
        movement=sum(a['Quantity']*LEAD[a['Route']] for a in orders)
        self.last_components=dict(unmet=self.unmet-old_unmet,lost=self.lost-old_lost,liter_transit=movement,requests=len(orders))
        return -(self.unmet-old_unmet)/1000-(self.lost-old_lost)/1000-.002*movement/1000-.002*len(orders)

    def conservation_error(self):
        transit=sum(a['Quantity'] for a in self.allocations if a['Status'] in ('PENDING','IN_TRANSIT'))
        return self.initial+self.offered-sum(map(sum,self.stock))-sum(map(sum,self.depot))-transit-self.served-self.lost

    def metrics(self):
        return dict(ticks=self.tick,served=self.served,unmet=self.unmet,service_level=self.served/max(self.served+self.unmet,1e-9),lost=self.lost,requests=self.requests,liter_transit=self.liter_transit,failures=self.failures,conservation_error=self.conservation_error(),stranded=sum(map(sum,self.depot))+sum(a['Quantity'] for a in self.allocations if a['Status'] in ('PENDING','IN_TRANSIT')))
