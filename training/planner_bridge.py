import json
import os
import subprocess
import select
import time
from pathlib import Path

class PlannerBridge:
    def __init__(self,path=None,timeout=10):
        self.timeout=timeout
        self.path=str(path or os.environ.get('FUELOPS_BRIDGE') or Path(__file__).parent/'bin'/'rlbridge')
        self.process=subprocess.Popen([self.path],stdin=subprocess.PIPE,stdout=subprocess.PIPE,bufsize=0)
        os.set_blocking(self.process.stdin.fileno(),False);os.set_blocking(self.process.stdout.fileno(),False)

    def evaluate(self,snapshot,history=None):
        payload=dict(schema_version=1,snapshots=[snapshot],history=[history or []])
        pending=(json.dumps(payload,allow_nan=False,separators=(',',':'))+'\n').encode();line=b'';deadline=time.monotonic()+self.timeout
        while not line.endswith(b'\n'):
            remaining=deadline-time.monotonic()
            if remaining<=0:
                self.process.terminate()
                raise TimeoutError('planner bridge request timed out')
            readable,writable,_=select.select([self.process.stdout],[self.process.stdin] if pending else [],[],remaining)
            if writable:pending=pending[os.write(self.process.stdin.fileno(),pending):]
            if readable:
                chunk=os.read(self.process.stdout.fileno(),65536)
                if not chunk:raise RuntimeError('planner bridge exited')
                line+=chunk
                if len(line)>2_000_000:raise ValueError('oversized planner response')
        response=json.loads(line)
        if response.get('error'):raise ValueError(response['error'])
        if response.get('schema_version')!=1 or len(response.get('results',[]))!=1:raise ValueError('invalid planner response')
        result=response['results'][0]
        if result.get('error'):raise ValueError(result['error'])
        if len(result['mask'])!=13 or not result['mask'][0]:raise ValueError('invalid action mask')
        return result

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:self.process.wait(timeout=.2)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:self.process.wait(timeout=.2)
                except subprocess.TimeoutExpired:self.process.kill();self.process.wait()
        self.process.stdout.close()
