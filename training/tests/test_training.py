import tempfile
import unittest
from training.env import FuelEnv
from training.train import build_model
from sb3_contrib import MaskablePPO

class TrainingTest(unittest.TestCase):
    def test_rollout_save_reload_masked_policy(self):
        env=FuelEnv(horizon=16)
        try:
            model=build_model(env,seed=11,device='cpu',n_steps=16,batch_size=16,n_epochs=1)
            model.learn(32)
            with tempfile.TemporaryDirectory() as d:
                model.save(d+'/actor')
                restored=MaskablePPO.load(d+'/actor',device='cpu')
                obs,_=env.reset(seed=3,options={'fixed':True})
                a,_=restored.predict(obs,action_masks=env.action_masks(),deterministic=True)
                self.assertTrue(env.action_masks()[int(a)])
        finally:env.close()
if __name__=='__main__':unittest.main()
