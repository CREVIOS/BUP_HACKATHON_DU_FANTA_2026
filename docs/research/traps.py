import json, urllib.request, threading, time
B="http://localhost:8000"
def r(p,m="GET",b=None):
    q=urllib.request.Request(B+p,method=m,data=json.dumps(b).encode() if b is not None else None,headers={"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(q,timeout=10) as x: return x.status, json.loads(x.read() or "null"), dict(x.headers)
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or "null"), dict(e.headers)
r("/admin/reset","POST"); r("/admin/faults/clear","POST")
sse=[]
def listen():
    with urllib.request.urlopen(B+"/v1/stream",timeout=30) as s:
        for line in s:
            line=line.decode().strip()
            if line.startswith("event:"): sse.append(line[7:])
threading.Thread(target=listen,daemon=True).start(); time.sleep(0.5)
tick=r("/v1/instance")[1]["tick"]
gz=lambda: r("/v1/depots/depot-gazipur")[1]["inventory"]["DIESEL"]
print("T1 route disruption starting THIS tick + allocation placed now")
r("/admin/events","POST",{"type":"route_disruption","start_tick":tick,"duration_ticks":2,"parameters":{"route_ids":["route-gazipur-mirpur"]}})
before=gz()
c,a,_=r("/v1/allocations","POST",{"idempotency_key":"t1","source_depot_id":"depot-gazipur","destination_station_id":"station-mirpur","route_id":"route-gazipur-mirpur","fuel_type":"DIESEL","quantity":3000})
print("  POST ->",c,a.get("status"))
r("/admin/step","POST")
a=[x for x in r("/v1/allocations")[1] if x["idempotency_key"]=="t1"][0]
print("  after step: status",a["status"],a["failure_reason"],"| depot diesel before",before,"after",gz(),"=> refunded?",gz()==before)
print("T2 empty route_ids = all routes? ")
r("/admin/events","POST",{"type":"route_disruption","start_tick":0,"duration_ticks":5,"parameters":{}}); r("/admin/step","POST")
print("  statuses:",{x["id"]:x["status"] for x in r("/v1/routes")[1]})
print("T3 idempotent replay code:", r("/v1/allocations","POST",{"idempotency_key":"t1","source_depot_id":"depot-gazipur","destination_station_id":"station-mirpur","route_id":"route-gazipur-mirpur","fuel_type":"DIESEL","quantity":3000})[0])
print("T4 destination cap ignores in-transit:")
r("/admin/reset","POST"); ok=0
for i in range(3):
    c,_,_=r("/v1/allocations","POST",{"idempotency_key":f"ov{i}","source_depot_id":"depot-gazipur","destination_station_id":"station-tongi","route_id":"route-gazipur-tongi","fuel_type":"OCTANE","quantity":2400}); ok+= c==201
print("  accepted",ok,"x 2400L to tongi OCTANE (inv 3500, cap 6000)")
for _ in range(3): r("/admin/step","POST")
print("  received:",[ (x["quantity"]) for x in r("/v1/allocations")[1]], "station octane now", r("/v1/stations/station-tongi")[1]["inventory"]["OCTANE"])
print("  audit received:",[x["metadata_json"] for x in r("/admin/audit?limit=100")[1] if x["action"]=="allocation.arrived"])
print("T5 stale_data header / error body shapes:")
r("/admin/faults","POST",{"type":"stale_data","duration_seconds":5}); print("  stale hdr:",r("/v1/stations")[2].get("x-simulator-stale") or r("/v1/stations")[2].get("X-Simulator-Stale"))
r("/admin/faults","POST",{"type":"stream_disconnect","duration_seconds":5}); print("  stream_disconnect:",r("/v1/stream")[:2])
r("/admin/faults","POST",{"type":"unavailable","duration_seconds":5}); print("  unavailable on stream:",r("/v1/stream")[:2]); print("  health during unavailable:",r("/v1/health")[0])
r("/admin/faults/clear","POST")
time.sleep(1); print("SSE event names seen:",sorted(set(sse)), "count",len(sse))
