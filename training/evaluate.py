"""Frozen scenario-level paired evaluation, with no test-set checkpoint selection."""
import argparse
import hashlib
import json
import random
import statistics
import multiprocessing
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from training.world import scenario, load_manifest, baseline

def fixed_action(result, preferred):
    if result['mask'][preferred]: return preferred
    target=result['plans'][preferred]['Shipments'] or []
    return next(i for i,p in enumerate(result['plans']) if result['mask'][i] and (p['Shipments'] or [])==target)

def make_cases(count, split='validation', horizon=576):
    offset={'validation':1_100_000_000,'test':1_300_000_000,'stress':1_500_000_000}[split]
    families=['baseline','demand_spike','supply_disruption','final_combined','normal','spike','route','supply','combined','outage']
    cases=[]
    for i in range(count):
        seed=offset+37*i;family=families[i%len(families)];cfg=scenario(seed,family)
        cases.append(dict(id=f'{split}-{i}',seed=seed,config=cfg,horizon=horizon,reference_noise=False))
    return cases

def paired_summary(baseline_rows, policy_rows, samples=2000):
    def keyed(rows):
        result={r.get('case_id',r['seed']):r for r in rows}
        if len(result)!=len(rows) or not rows: raise ValueError('empty or duplicate evaluation cases')
        return result
    a,b=keyed(baseline_rows),keyed(policy_rows)
    if a.keys()!=b.keys(): raise ValueError('unpaired evaluation cases')
    for k in a:
        if a[k].get('manifest_sha256')!=b[k].get('manifest_sha256'): raise ValueError('manifest mismatch')
    delta=[a[k]['unmet']-b[k]['unmet'] for k in a];rng=random.Random(20260929)
    boot=sorted(statistics.fmean(rng.choices(delta,k=len(delta))) for _ in range(samples))
    mean=statistics.fmean(delta);base=statistics.fmean(r['unmet'] for r in a.values())
    return dict(cases=len(delta),unmet_improvement_mean=mean,unmet_improvement_percent=100*mean/base if base else None,unmet_improvement_ci95=[boot[int(samples*.025)],boot[int(samples*.975)]],service_change_pp=100*statistics.fmean(b[k]['service_level']-a[k]['service_level'] for k in a),request_change_mean=statistics.fmean(b[k]['requests']-a[k]['requests'] for k in a))

def comparisons(results, baseline_name):
    if baseline_name not in results:raise ValueError('selected baseline absent')
    return {name:paired_summary(results[baseline_name],rows) for name,rows in results.items()}

def rollout(cases, model=None, policy='greedy'):
    from training.env import FuelEnv
    from training.train import choose
    rows=[];env=FuelEnv()
    try:
        for case in cases:
            env.horizon=case['horizon']
            obs,_=env.reset(seed=case['seed'],options={'fixed':True,'config':case['config'],'reference_noise':case['reference_noise']})
            counts=[0]*13
            for _ in range(case['horizon']):
                if model is not None:action=choose(model,obs,env.action_masks())
                elif policy=='noop':action=0
                elif policy=='greedy':action=env.result['baseline_action']
                else:action=fixed_action(env.result,int(policy.split(':')[1]))
                counts[action]+=1;obs,_,_,_,_=env.step(action)
            rows.append(dict(env.world.metrics(),case_id=case['id'],seed=case['seed'],family=case['config']['family'],supply_count=len(case['config']['supplies']),manifest_sha256=hashlib.sha256(json.dumps(case,sort_keys=True).encode()).hexdigest(),action_counts=counts))
    finally:env.close()
    return rows

def means(rows):
    return {k:statistics.fmean(r[k] for r in rows) for k in ('served','unmet','service_level','lost','requests','liter_transit','failures','stranded')}

def policy_job(job):
    label,checkpoint,cases,device=job
    import torch
    torch.set_num_threads(1)
    model=None
    if checkpoint:
        from sb3_contrib import MaskablePPO
        model=MaskablePPO.load(checkpoint,device=device)
    return label,rollout(cases,model,label)

def main():
    p=argparse.ArgumentParser();p.add_argument('--checkpoints',nargs='*',default=[]);p.add_argument('--policies',nargs='+',default=['noop','greedy','fixed:9','fixed:10','fixed:11','fixed:12']);p.add_argument('--count',type=int,default=200);p.add_argument('--split',choices=['validation','test','stress'],default='test');p.add_argument('--output',required=True);p.add_argument('--device',default='cpu');p.add_argument('--workers',type=int,default=4);p.add_argument('--baseline',default='greedy');args=p.parse_args()
    cases=make_cases(args.count,args.split)
    for name in ('baseline','demand_spike','supply_disruption','final_combined'):
        cfg=load_manifest(name);cases.append(dict(id='exact-'+name,seed=cfg['seed'],config=cfg,horizon=576,reference_noise=True))
    output=Path(args.output);output.parent.mkdir(parents=True,exist_ok=True)
    result=dict(split=args.split,cases=cases,results={},summaries={},paired_vs_selected={},selected_baseline=args.baseline,promotion=False)
    output.write_text(json.dumps(result,indent=2))
    jobs=[(name,None,cases,args.device) for name in args.policies]+[(str(path),str(path),cases,args.device) for path in args.checkpoints]
    with ProcessPoolExecutor(max_workers=args.workers,mp_context=multiprocessing.get_context('spawn')) as pool:
        for future in as_completed([pool.submit(policy_job,job) for job in jobs]):
            label,rows=future.result();result['results'][label]=rows;result['summaries'][label]=means(rows[:args.count])
            if args.baseline in result['results']:result['paired_vs_selected']=comparisons({k:v[:args.count] for k,v in result['results'].items()},args.baseline)
            output.write_text(json.dumps(result,indent=2));print(json.dumps({'policy':label,'summary':result['summaries'][label],'paired':result['paired_vs_selected'].get(label)}),flush=True)
if __name__=='__main__': main()
