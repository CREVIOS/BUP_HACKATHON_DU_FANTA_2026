import json
import os
import subprocess
from pathlib import Path

class PlannerBridge:
    def __init__(self,path=None):
        self.path=str(path or os.environ.get('FUELOPS_BRIDGE') or Path(__file__).parent/'bin'/'rlbridge')
        self.process=subprocess.Popen([self.path],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1)

    def evaluate(self,snapshot,history=None):
        payload=dict(schema_version=1,snapshots=[snapshot],history=[history or []])
        self.process.stdin.write(json.dumps(payload,allow_nan=False,separators=(',',':'))+'\n');self.process.stdin.flush()
        line=self.process.stdout.readline()
        if not line:raise RuntimeError('planner bridge exited')
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
            try:self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:self.process.terminate();self.process.wait(timeout=3)
        self.process.stdout.close()
