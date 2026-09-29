# Probe only: naive zero-overflow order-up-to policy driven by /admin/step, to measure achievable service_level.
import json, sys, urllib.request
B="http://localhost:8000"; N=int(sys.argv[1])
def r(p,m="GET",b=None):
    q=urllib.request.Request(B+p,method=m,data=json.dumps(b).encode() if b is not None else None,headers={"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(q,timeout=10) as x: return x.status,json.loads(x.read())
    except urllib.error.HTTPError as e: return e.code,json.loads(e.read())
r("/admin/reset","POST"); F=("DIESEL","PETROL","OCTANE"); fails={}; marks={}
for _ in range(N):
    inst=r("/v1/instance")[1]; T=inst["tick"]
    st={s["id"]:s for s in r("/v1/stations")[1]}; dp={d["id"]:d for d in r("/v1/depots")[1]}
    routes=sorted(r("/v1/routes")[1],key=lambda x:x["transit_ticks"])
    ev=r("/v1/events")[1]; alloc=r("/v1/allocations")[1]
    blocked={rid for e in ev if e["type"]=="route_disruption" and e["status"]=="SCHEDULED" and e["start_tick"]<=T for rid in e["parameters"].get("route_ids",[])}
    intr={}; sent={}
    for a in alloc:
        if a["status"] in("PENDING","IN_TRANSIT"): intr[(a["destination_station_id"],a["fuel_type"])]=intr.get((a["destination_station_id"],a["fuel_type"]),0)+a["quantity"]
        if a["created_tick"]==T and a["status"] in("PENDING","IN_TRANSIT"): sent[a["source_depot_id"]]=sent.get(a["source_depot_id"],0)+a["quantity"]
    # most-depleted first (days of cover)
    need=[]
    for s in st.values():
        if s["status"]!="OPEN": continue
        for f in F:
            room=s["capacity"][f]-s["inventory"][f]-intr.get((s["id"],f),0)
            if room>=500: need.append((s["inventory"][f]/s["capacity"][f],s["id"],f,room))
    for _,sid,f,room in sorted(need):
        for rt in routes:
            if rt["destination_station_id"]!=sid or rt["status"]!="AVAILABLE" or rt["id"] in blocked: continue
            d=dp[rt["source_depot_id"]]
            q=int(min(room,rt["max_shipment"],d["inventory"][f],d["dispatch_capacity_per_tick"]-sent.get(d["id"],0)))
            if q<500: continue
            c,res=r("/v1/allocations","POST",{"idempotency_key":f"g-{T}-{rt['id']}-{f}","source_depot_id":d["id"],"destination_station_id":sid,"route_id":rt["id"],"fuel_type":f,"quantity":q})
            if c==201: d["inventory"][f]-=q; sent[d["id"]]=sent.get(d["id"],0)+q; break
            fails[res["detail"]["code"]]=fails.get(res["detail"]["code"],0)+1
    r("/admin/step","POST")
    if T+1 in (96,192,288,384,480,576): marks[T+1]=r("/v1/metrics")[1]["service_level"]
m=r("/v1/metrics")[1]; print(inst["scenario_id"],"ticks",N,"service_level",m["service_level"],"failures",m["allocation_failures"],"per-day-mark",marks,"rejections",fails)
