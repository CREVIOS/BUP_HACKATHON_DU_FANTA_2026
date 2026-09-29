import sys, yaml, hashlib, random
from datetime import datetime, timedelta
sys.path.insert(0,'simsrc')
def _rng(seed,tick,entity,purpose):
    n=int.from_bytes(hashlib.sha256(f"{seed}:{tick}:{entity}:{purpose}".encode()).digest()[:8],"big"); return random.Random(n)
def hf(h,p):
    if p=="industrial": return 1.55 if 6<=h<18 else 0.45
    if p=="highway": return 1.35 if 6<=h<10 or 16<=h<21 else 0.75
    if p=="urban_high": return 1.45 if 7<=h<10 or 16<=h<21 else 0.70
    return 1.25 if 7<=h<21 else 0.65
F=("DIESEL","PETROL","OCTANE")
for scen in ["baseline","final_combined"]:
    s=yaml.safe_load(open(f"simsrc/scenarios/{scen}.yaml")); seed=s["seed"]
    reg={r["id"]:r["demand_factor"] for r in s["regions"]}
    t0=datetime.fromisoformat(s["start_time"])
    stock={f:sum(x["initial_inventory"][f] for x in s["depots"]+s["stations"]) for f in F}
    arr=s.get("supply_arrivals",[])
    print(f"== {scen} seed={seed}  initial system stock {stock}  total arrivals {{f: sum}}:",{f:sum(a['quantity'] for a in arr if a['fuel_type']==f) for f in F})
    cumd={f:0.0 for f in F}; cums={f:float(stock[f]) for f in F}; runout={}
    perday={}
    for tick in range(0,96*6):
        h=(t0+timedelta(minutes=15*tick)).hour
        for a in arr:
            if a["arrival_tick"]==tick: cums[a["fuel_type"]]+=a["quantity"]
        for st in s["stations"]:
            p=s["demand_profiles"][st["demand_profile"]]
            for f in F:
                d=p["daily_liters"][f]/96*hf(h,st["demand_profile"])*reg[st["region_id"]]*(1+_rng(seed,tick,st["id"],f"demand:{f}").uniform(-p["noise"],p["noise"]))
                cumd[f]+=d; perday.setdefault(tick//96,{}).setdefault(f,0); perday[tick//96][f]+=d
        for f in F:
            if f not in runout and cumd[f]>cums[f]: runout[f]=tick
    print(" demand/day (no spikes):",{d:{f:round(v) for f,v in x.items()} for d,x in perday.items()})
    print(" tick when cumulative demand > all fuel ever in system (hard ceiling, no spikes):",runout)
    print(" cum demand @ tick 212:", end=" ")
