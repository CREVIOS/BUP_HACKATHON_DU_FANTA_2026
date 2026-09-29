import unittest
from training.world import World, baseline, event


class WorldTests(unittest.TestCase):
    def test_departure_arrival_and_conservation(self):
        w = World(baseline(), seed=1)
        old = w.stock[0][0]
        w.advance([dict(Depot=0, Station=0, Route=0, Fuel=0, Quantity=1000)], demand=[[0]*3 for _ in range(4)])
        self.assertEqual(w.tick, 1)
        self.assertEqual(w.allocations[0]['Status'], 'IN_TRANSIT')
        self.assertEqual(w.stock[0][0], old)
        w.advance([], demand=[[0]*3 for _ in range(4)])
        self.assertEqual(w.stock[0][0], old)
        w.advance([], demand=[[0]*3 for _ in range(4)])
        self.assertEqual(w.stock[0][0], old+1000)
        self.assertAlmostEqual(w.conservation_error(), 0)

    def test_departure_disruption_loses_fuel(self):
        cfg = baseline()
        cfg['events'] = [event('route_disruption', 0, 2, Routes=[0])]
        w = World(cfg)
        w.advance([dict(Depot=0, Station=0, Route=0, Fuel=0, Quantity=1000)], demand=[[0]*3 for _ in range(4)])
        self.assertEqual(w.allocations[0]['Status'], 'FAILED')
        self.assertEqual(w.lost, 1000)
        self.assertAlmostEqual(w.conservation_error(), 0)

    def test_invalid_batch_is_not_partially_applied(self):
        w = World(baseline())
        old = w.depot[0][0]
        with self.assertRaises(ValueError):
            w.advance([dict(Depot=0, Station=0, Route=0, Fuel=0, Quantity=-1)])
        self.assertEqual(w.tick, 0)
        self.assertEqual(w.depot[0][0], old)

    def test_demand_is_independent_of_policy(self):
        a, b = World(baseline(),seed=23), World(baseline(),seed=23)
        for t in range(8):
            order=[dict(Depot=0,Station=0,Route=0,Fuel=0,Quantity=1)] if t==0 else []
            a.advance(order); b.advance([])
            self.assertEqual(a.last_demand,b.last_demand)

    def test_hidden_event_not_exposed(self):
        cfg=baseline();cfg['events']=[event('demand_spike',4,4,Reveal=3,Stations=[0],Multiplier=2)]
        w=World(cfg)
        self.assertEqual(w.snapshot()['Events'],[])
        for _ in range(3):w.advance([])
        self.assertEqual(len(w.snapshot()['Events']),1)

if __name__ == '__main__': unittest.main()
