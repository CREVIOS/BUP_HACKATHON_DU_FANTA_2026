"""Launch one bounded training process; read W&B key securely from the terminal."""
import argparse
import getpass
import json
import os
import subprocess
import sys
from pathlib import Path

def main():
    p=argparse.ArgumentParser();p.add_argument('--run-dir',required=True);p.add_argument('--seed',type=int,default=11);p.add_argument('--seeds',nargs='+',type=int);p.add_argument('--steps',type=int,default=200000);p.add_argument('--envs',type=int,default=8);p.add_argument('--max-hours',type=float,default=2);p.add_argument('--warmstart',action='store_true');args=p.parse_args()
    path=Path(args.run_dir);path.mkdir(parents=True,exist_ok=True)
    env=os.environ.copy();env['WANDB_API_KEY']=getpass.getpass('W&B API key (not saved): ');env['FUELOPS_BRIDGE']=str(Path('training/bin/rlbridge-linux').resolve())
    env['OMP_NUM_THREADS']='1';env['MKL_NUM_THREADS']='1'
    cmd=[sys.executable,'-m','training.train','--seed',str(args.seed),'--steps',str(args.steps),'--envs',str(args.envs),'--run-dir',str(path),'--max-hours',str(args.max_hours),'--wandb']
    if args.warmstart:cmd.append('--warmstart')
    if args.seeds:cmd=[sys.executable,'-m','training.sweep','--seeds']+list(map(str,args.seeds))+['--steps',str(args.steps),'--envs',str(args.envs),'--run-dir',str(path),'--max-hours',str(args.max_hours)]
    with (path/'console.log').open('a') as log:
        process=subprocess.Popen(cmd,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,stdin=subprocess.DEVNULL)
    (path/'pid').write_text(str(process.pid)+'\n');print(json.dumps({'pid':process.pid,'run_dir':str(path),'log':str(path/'console.log')}))
if __name__=='__main__':main()
