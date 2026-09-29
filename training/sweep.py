"""Bounded sequential multi-seed experiment with frozen held-out evaluation."""
import argparse
import json
import os
import subprocess
import sys
import time
import signal
from pathlib import Path

def wait_job(child, timeout):
    try:return child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid,signal.SIGTERM)
        try:child.wait(timeout=2)
        except subprocess.TimeoutExpired:pass
        finally:
            try:os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            child.wait()
        raise

def main():
    p=argparse.ArgumentParser();p.add_argument('--run-dir',required=True);p.add_argument('--seeds',nargs='+',type=int,default=[11,23,37]);p.add_argument('--steps',type=int,default=3000000);p.add_argument('--envs',type=int,default=8);p.add_argument('--max-hours',type=float,default=.8);args=p.parse_args()
    root=Path(args.run_dir);root.mkdir(parents=True,exist_ok=True);deadline=time.monotonic()+args.max_hours*3600
    status=dict(seeds=args.seeds,steps_per_seed=args.steps,completed=[],failed=[],phase='baseline_validation',promotion=False)
    def save(): (root/'status.json').write_text(json.dumps(status,indent=2));print(json.dumps(status),flush=True)
    def run(module,arguments,log):
        remaining=deadline-time.monotonic()
        if remaining<=0: raise TimeoutError('experiment wall-clock budget exhausted')
        with log.open('a') as stream:
            child=subprocess.Popen([sys.executable,'-m',module]+arguments,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
            status['active_pid']=child.pid;save()
            code=wait_job(child,remaining)
            if code:raise RuntimeError(f'{module} failed with exit {code}; see {log}')
    save()
    validation=root/'baseline-validation.json'
    run('training.evaluate',['--split','validation','--count','20','--policies','greedy']+['fixed:'+str(i) for i in range(1,13)]+['--output',str(validation)],root/'baseline-validation.log')
    candidates=json.loads(validation.read_text())['summaries']
    best=min(candidates,key=lambda k:candidates[k]['unmet']+candidates[k]['lost']+2*candidates[k]['requests']+.002*candidates[k]['liter_transit'])
    status['baseline_selected_on_validation']=best;save()
    processes=[];training_deadline=min(deadline-600,time.monotonic()+30*60)
    try:
        for seed in args.seeds:
            path=root/f'seed-{seed}';path.mkdir(exist_ok=True);status['phase']='training';save()
            stream=(path/'console.log').open('a')
            args_train=['--seed',str(seed),'--steps',str(args.steps),'--envs',str(args.envs),'--run-dir',str(path),'--max-hours',str(max(.01,(training_deadline-time.monotonic()-90)/3600)),'--eval-every','262144','--warmstart','--wandb']
            child=subprocess.Popen([sys.executable,'-m','training.train']+args_train,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
            processes.append((seed,path,child,stream))
        status['active_pids']={seed:child.pid for seed,_,child,_ in processes};save()
        for seed,path,child,stream in processes:
            code=wait_job(child,max(1,training_deadline-time.monotonic()))
            if code:raise RuntimeError(f'training seed {seed} exited {code}')
            status['completed'].append(str(path/'selected.zip'));save()
    except Exception as exc:
        status['failed'].append(dict(error=str(exc)));save();raise
    finally:
        for _,_,child,stream in processes:
            if child.poll() is None:
                try:wait_job(child,.01)
                except subprocess.TimeoutExpired:pass
            stream.close()
    status['phase']='held_out_evaluation';save()
    output=root/'held-out.json';policies=list(dict.fromkeys(['noop','greedy',best]))
    run('training.evaluate',['--split','test','--count','200','--baseline',best,'--workers','6','--policies']+policies+['--checkpoints']+status['completed']+['--output',str(output)],root/'held-out.log')
    import wandb
    report=json.loads(output.read_text())
    with wandb.init(entity='eenlp',project='BUP',name=root.name+'-held-out',group='fuelops-mixed-manifests-v2',config={'seeds':args.seeds,'cases':200,'baseline_selected_on_validation':best,'promotion':False},dir=str(root.resolve()),save_code=False) as runlog:
        for label,metrics in report['summaries'].items():
            name=Path(label).parent.name if label.endswith('.zip') else label
            runlog.summary.update({name+'/'+k:v for k,v in metrics.items()})
        artifact=wandb.Artifact(root.name+'-evaluation',type='evaluation');artifact.add_file(str(output));artifact.add_file(str(validation));runlog.log_artifact(artifact)
        status['evaluation_wandb_url']=runlog.url
    status['phase']='complete';status.pop('active_pid',None);status.pop('active_seed',None);save()
if __name__=='__main__': main()
