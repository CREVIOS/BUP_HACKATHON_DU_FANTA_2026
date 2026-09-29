import sys, threading, time, urllib.request, collections
B="http://localhost:8000"; path=sys.argv[2]; c=int(sys.argv[1])
codes=collections.Counter(); lat=[]; lk=threading.Lock()
def w():
    for _ in range(15):
        t=time.perf_counter()
        try:
            with urllib.request.urlopen(B+path,timeout=8) as r: code=r.status; r.read()
        except urllib.error.HTTPError as e: code=e.code
        except Exception as e: code=type(e).__name__
        with lk: codes[code]+=1; lat.append((time.perf_counter()-t)*1000)
ts=[threading.Thread(target=w) for _ in range(c)]; t0=time.perf_counter(); [t.start() for t in ts]; [t.join() for t in ts]
lat.sort(); print(f"c={c} {path} rps={len(lat)/(time.perf_counter()-t0):.0f} p50={lat[len(lat)//2]:.0f}ms p95={lat[int(len(lat)*.95)]:.0f}ms codes={dict(codes)}", flush=True)
