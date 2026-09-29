"""Reproducible Maskable PPO runs; W&B receives metrics/config, never credentials."""
import argparse
import json
import os
import platform
import time
import hashlib
from collections import deque
from pathlib import Path

import numpy as np
import torch
from sb3_contrib import MaskablePPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.vec_env import SubprocVecEnv, DummyVecEnv
from training.env import FuelEnv

def build_model(env,seed=11,device='cpu',**overrides):
    cfg=dict(n_steps=256,batch_size=256,n_epochs=4,learning_rate=3e-4,gamma=.997,gae_lambda=.98,clip_range=.2,max_grad_norm=.5,ent_coef=.01,vf_coef=.5,target_kl=.02)
    cfg.update(overrides)
    return MaskablePPO('MlpPolicy',env,seed=seed,device=device,policy_kwargs=dict(net_arch=dict(pi=[128,128],vf=[128,128]),activation_fn=torch.nn.Tanh),verbose=0,**cfg)

def choose(model,obs,mask):
    with torch.no_grad():
        tensor,_=model.policy.obs_to_tensor(obs)
        logits=model.policy.get_distribution(tensor,action_masks=mask).distribution.logits.detach().cpu().numpy()[0]
    valid=np.flatnonzero(mask)
    return int(valid[logits[valid]>=logits[valid].max()-1e-4][0])

def evaluate(model,count=8,horizon=576,baseline_policy=None,seed_offset=1_100_000_000):
    from training.evaluate import make_cases, rollout, means
    if seed_offset!=1_100_000_000:raise ValueError('use frozen evaluation splits')
    policy='greedy' if baseline_policy is None else ('fixed:'+str(baseline_policy) if isinstance(baseline_policy,int) else baseline_policy)
    rows=rollout(make_cases(count,'validation',horizon),model if baseline_policy is None else None,policy)
    return means(rows),rows

def warm_start(model,episodes=64,horizon=576,epochs=10):
    """Balanced imitation pretraining; all trajectories are in the training split."""
    env=FuelEnv(horizon=horizon);observations=[];masks=[];actions=[]
    try:
        for i in range(episodes):
            obs,_=env.reset(seed=700_000_000+37*i,options={'fixed':True})
            for _ in range(horizon):
                action=env.result['baseline_action']
                observations.append(obs);masks.append(env.action_masks());actions.append(action)
                obs,_,_,_,_=env.step(action)
    finally:env.close()
    x=torch.as_tensor(np.asarray(observations),device=model.device)
    mask=torch.as_tensor(np.asarray(masks),device=model.device)
    y=torch.as_tensor(actions,device=model.device,dtype=torch.long)
    counts=torch.bincount(y,minlength=13).clamp_min(1).float()
    weights=counts.rsqrt();weights=weights/weights.mean()
    def loss(indices):
        distribution=model.policy.get_distribution(x[indices],action_masks=mask[indices])
        return torch.nn.functional.cross_entropy(distribution.distribution.logits,y[indices],weight=weights)
    indices=torch.arange(len(y),device=model.device)
    with torch.no_grad():before=float(loss(indices).item())
    for _ in range(epochs):
        for batch in torch.randperm(len(y),device=model.device).split(256):
            objective=loss(batch);model.policy.optimizer.zero_grad();objective.backward();torch.nn.utils.clip_grad_norm_(model.policy.parameters(),.5);model.policy.optimizer.step()
    with torch.no_grad():after=float(loss(indices).item())
    return dict(loss_before=before,loss_after=after,examples=len(actions),expert_ship_decisions=sum(a!=0 for a in actions))

class Track(BaseCallback):
    def __init__(self,path,run=None,max_seconds=20*3600,eval_every=65536):
        super().__init__();self.path=Path(path);self.run=run;self.started=time.monotonic();self.episodes=deque(maxlen=64);self.last_log=0;self.last_eval=0;self.max_seconds=max_seconds;self.eval_every=eval_every;self.best=float('inf')
        self.file=(self.path/'metrics.jsonl').open('a',buffering=1)
    def record(self,metrics):
        metrics=dict(metrics,steps=self.num_timesteps,elapsed_seconds=time.monotonic()-self.started)
        self.file.write(json.dumps(metrics,allow_nan=False)+'\n');print(json.dumps(metrics),flush=True)
        if self.run:self.run.log(metrics,step=self.num_timesteps)
    def _on_step(self):
        for info in self.locals['infos']:
            if 'outcomes' in info:self.episodes.append(info['outcomes'])
        if self.num_timesteps-self.last_log>=16384:
            self.last_log=self.num_timesteps;metrics={'throughput/steps_per_second':self.num_timesteps/max(time.monotonic()-self.started,1)}
            for key,val in self.model.logger.name_to_value.items():
                if isinstance(val,(int,float,np.floating)) and np.isfinite(val):metrics[key]=float(val)
            if self.episodes:
                for key in self.episodes[0]:metrics['train_episode/'+key]=float(np.mean([e[key] for e in self.episodes]))
            self.record(metrics);self.model.save(self.path/'latest')
        if self.eval_every and self.num_timesteps-self.last_eval>=self.eval_every:
            self.last_eval=self.num_timesteps;metrics,_=evaluate(self.model,count=20)
            self.record({'validation/'+k:v for k,v in metrics.items()})
            score=metrics['unmet']+metrics['lost']+2*metrics['requests']+.002*metrics['liter_transit']
            if score<self.best:self.best=score;self.model.save(self.path/'best')
        return time.monotonic()-self.started<self.max_seconds

def main():
    p=argparse.ArgumentParser();p.add_argument('--seed',type=int,default=11);p.add_argument('--steps',type=int,default=200000);p.add_argument('--envs',type=int,default=8);p.add_argument('--device',default='cuda');p.add_argument('--run-dir',required=True);p.add_argument('--wandb',action='store_true');p.add_argument('--warmstart',action='store_true');p.add_argument('--max-hours',type=float,default=4);p.add_argument('--gamma',type=float,default=.997);p.add_argument('--entropy',type=float,default=.01);p.add_argument('--horizon',type=int,default=576);p.add_argument('--eval-every',type=int,default=65536);args=p.parse_args()
    torch.set_num_threads(1)
    path=Path(args.run_dir);path.mkdir(parents=True,exist_ok=True)
    code_hash=hashlib.sha256(b''.join(p.read_bytes() for p in sorted(Path('training').glob('*.py')))).hexdigest()
    config=vars(args)|dict(architecture='masked-plan-ppo-128x128',action_count=13,training_distribution='bup-mixed-manifests-v2',source_sha256=code_hash,manifests_sha256=hashlib.sha256((Path(__file__).parent/'scenarios/official.json').read_bytes()).hexdigest(),torch=torch.__version__,python=platform.python_version(),gpu=torch.cuda.get_device_name(0) if torch.cuda.is_available() else None)
    (path/'config.json').write_text(json.dumps(config,indent=2))
    run=None
    if args.wandb:
        import wandb
        run=wandb.init(entity='eenlp',project='BUP',name=path.name,group='fuelops-masked-ppo-v1',config=config,dir=str(path.resolve()),save_code=False,settings=wandb.Settings(init_timeout=90))
        (path/'wandb_url.txt').write_text(run.url+'\n');print(json.dumps({'wandb_url':run.url}),flush=True)
    make=lambda:FuelEnv(horizon=args.horizon)
    env=SubprocVecEnv([make for _ in range(args.envs)],start_method='spawn') if args.envs>1 else DummyVecEnv([make])
    callback=Track(path,run,max_seconds=args.max_hours*3600,eval_every=args.eval_every)
    try:
        model=build_model(env,args.seed,args.device,gamma=args.gamma,ent_coef=args.entropy)
        if args.warmstart:
            warm=warm_start(model);print(json.dumps({'warmstart':warm}),flush=True)
            if run:run.log({'warmstart/'+k:v for k,v in warm.items()},step=0)
            metrics,_=evaluate(model,count=20)
            callback.record({'warmstart_validation/'+k:v for k,v in metrics.items()})
            callback.best=metrics['unmet']+metrics['lost']+2*metrics['requests']+.002*metrics['liter_transit']
            model.save(path/'best');model.save(path/'warmstart')
        print(json.dumps({'status':'training','observations':env.observation_space.shape,'device':str(model.device),'steps':args.steps}),flush=True)
        model.learn(args.steps,callback=callback)
        model.save(path/'final')
        selected=MaskablePPO.load(path/'best',device=args.device) if (path/'best.zip').exists() else model
        selected.save(path/'selected')
        result,_=evaluate(selected,count=40,horizon=576)
        (path/'validation.json').write_text(json.dumps(result,indent=2))
        callback.record({'final_validation/'+k:v for k,v in result.items()})
        if run:
            run.summary.update(result)
            import wandb
            artifact=wandb.Artifact(path.name+'-policy',type='model',metadata={'promotion':'unvalidated','seed':args.seed})
            artifact.add_file(str(path/'selected.zip'));artifact.add_file(str(path/'config.json'));run.log_artifact(artifact)
    finally:
        env.close();callback.file.close()
        if run:run.finish()
if __name__=='__main__':main()
