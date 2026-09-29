import unittest
from training.evaluate import paired_summary, fixed_action, make_cases

class EvaluationTests(unittest.TestCase):
    def test_pair_by_seed_and_reject_missing(self):
        a=[dict(seed=1,unmet=100.,requests=10.,service_level=.9),dict(seed=2,unmet=200.,requests=20.,service_level=.8)]
        b=list(reversed(a))
        result=paired_summary(a,b)
        self.assertEqual(result['unmet_improvement_mean'],0)
        self.assertEqual(result['unmet_improvement_ci95'],[0,0])
        with self.assertRaises(ValueError):paired_summary(a,b[:1])
        c=[dict(seed=1,unmet=50.,requests=10.,service_level=.95),dict(seed=2,unmet=100.,requests=20.,service_level=.9)]
        result=paired_summary(a,c)
        self.assertEqual(result['unmet_improvement_mean'],75)
        self.assertEqual(result['unmet_improvement_percent'],50)
        with self.assertRaises(ValueError):paired_summary(a,a+a)

    def test_duplicate_plan_uses_equivalent_valid_action(self):
        result={'mask':[True,True,False], 'plans':[{'Shipments':None},{'Shipments':[{'Quantity':3}]},{'Shipments':[{'Quantity':3}]}]}
        self.assertEqual(fixed_action(result,2),1)

    def test_frozen_cases_cover_regimes_and_splits(self):
        cases=make_cases(40,'validation')
        self.assertEqual(cases,make_cases(40,'validation'))
        self.assertEqual({len(c['config']['supplies']) for c in cases},{4,22})
        self.assertTrue(set(c['seed'] for c in cases).isdisjoint(c['seed'] for c in make_cases(40,'test')))
if __name__=='__main__':unittest.main()
