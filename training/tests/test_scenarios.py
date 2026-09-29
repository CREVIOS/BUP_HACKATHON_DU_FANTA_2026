import copy
import unittest
from training import world


class ScenarioTests(unittest.TestCase):
    def test_exact_crisis_manifest_has_four_supplies_and_region_scope(self):
        self.assertTrue(hasattr(world, 'load_manifest'), 'exact manifest loader missing')
        cfg = world.load_manifest('final_combined')
        self.assertEqual(cfg['seed'], 9001)
        self.assertEqual(len(cfg['supplies']), 4)
        self.assertEqual(cfg['events'][0]['Stations'], [0, 1])
        w = world.World(cfg, seed=cfg['seed'], reference_noise=True)
        for _ in range(9): w.advance([])
        self.assertEqual(w.multiplier, [1.7, 1.7, 1, 1])
        self.assertEqual(len(world.load_manifest('baseline')['supplies']), 22)
        cfg['supplies'].clear()
        self.assertEqual(len(world.load_manifest('final_combined')['supplies']), 4)

    def test_training_covers_both_supply_regimes(self):
        counts = {len(world.scenario(i)['supplies']) for i in range(40)}
        self.assertEqual(counts, {4, 22})

    def test_manifest_rejects_unsupported_topology(self):
        self.assertTrue(hasattr(world, 'import_manifest'), 'manifest validator missing')
        from training.scenarios import MANIFESTS
        data = copy.deepcopy(MANIFESTS['baseline'])
        data['routes'][0]['transit_ticks'] = 17
        with self.assertRaises(ValueError): world.import_manifest(data)
        data = copy.deepcopy(MANIFESTS['baseline'])
        data['preloaded_events'] = [dict(type='demand_spike', start_tick=0, duration_ticks=1, parameters={'region_ids':['unknown'], 'multiplier':2})]
        with self.assertRaises(ValueError): world.import_manifest(data)

if __name__ == '__main__': unittest.main()
