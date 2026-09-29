import gymnasium as gym
import numpy as np
from training.world import World,scenario
from training.planner_bridge import PlannerBridge

class FuelEnv(gym.Env):
    metadata={'render_modes':[]}
    def __init__(self,horizon=576,family=None,synthetic=True,bridge_path=None):
        self.horizon=horizon;self.family=family;self.synthetic=synthetic;self.bridge=PlannerBridge(bridge_path)
        self.action_space=gym.spaces.Discrete(13)
        self.reset(seed=0,options={'fixed':True})
        self.observation_space=gym.spaces.Box(-10,10,(len(self.result['features']),),dtype=np.float32)
    def _observe(self):
        self.result=self.bridge.evaluate(self.world.snapshot(),self.world.history)
        return np.asarray(self.result['features'],dtype=np.float32)
    def reset(self,seed=None,options=None):
        super().reset(seed=seed)
        chosen=int(seed) if options and options.get('fixed') and seed is not None else int(self.np_random.integers(0,1_000_000_000))
        self.manifest_seed=chosen;cfg=scenario(chosen,self.family,self.synthetic);self.world=World(cfg,chosen);self.steps=0
        return self._observe(),{'manifest_seed':chosen,'family':cfg['family']}
    def action_masks(self):return np.asarray(self.result['mask'],dtype=bool)
    def step(self,action):
        action=int(action)
        if not 0<=action<13 or not self.result['mask'][action]:
            raise ValueError('masked action: no inventory mutation')
        orders=self.result['plans'][action]['Shipments'] or []
        reward=self.world.advance(orders);self.steps+=1
        if abs(self.world.conservation_error())>max(.02,self.world.tick*.015):raise RuntimeError('fuel conservation violated')
        info=dict(self.world.last_components,manifest_seed=self.manifest_seed)
        truncated=self.steps>=self.horizon
        if truncated:info['outcomes']=self.world.metrics()
        return self._observe(),float(reward),False,truncated,info
    def close(self):self.bridge.close()
