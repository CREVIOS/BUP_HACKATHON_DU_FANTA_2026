import unittest
import numpy as np
from training.env import FuelEnv

class EnvTests(unittest.TestCase):
    def test_mask_truncation_and_reproducibility(self):
        env=FuelEnv(horizon=3)
        try:
            first,_=env.reset(seed=23,options={'fixed':True})
            for t in range(3):
                self.assertTrue(env.action_masks()[0])
                obs,reward,terminated,truncated,info=env.step(0)
                self.assertFalse(terminated)
                self.assertEqual(truncated,t==2)
                self.assertTrue(np.isfinite(reward))
            second,_=env.reset(seed=23,options={'fixed':True})
            np.testing.assert_array_equal(first,second)
        finally:env.close()

if __name__=='__main__':unittest.main()
