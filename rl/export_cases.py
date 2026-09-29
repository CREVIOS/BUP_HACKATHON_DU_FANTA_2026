"""Turn the frozen held-out test cases into real-simulator runs with an exact SB3 reference.

For every case of training.evaluate.make_cases(count, split) this writes <out>/<case-id>/:
  scenario.yaml  the case as an official-simulator scenario (initial stock, depots, supplies, visible events, seed)
  case.json      events hidden until a reveal tick (injected via /admin/events at that tick), and the reference:
                 per tick the SB3 choose() action, the 13-bit mask and two observation checksums, plus final metrics.
The reference uses reference_noise=True, i.e. the simulator's own sha256 demand noise, so a faithful live
integration must reproduce it decision for decision. Run from the verified HF package root:
  PYTHONPATH=$PWD FUELOPS_BRIDGE=$PWD/training/bin/rlbridge python rl/export_cases.py <out> [count] [workers]
"""
import copy, json, sys
from multiprocessing import Pool
from pathlib import Path
import yaml

STATIONS = ['station-mirpur', 'station-tongi', 'station-karnaphuli', 'station-coxsbazar']
DEPOTS = ['depot-gazipur', 'depot-patiya']
FUELS = ['DIESEL', 'PETROL', 'OCTANE']
ROUTES = ['route-gazipur-mirpur', 'route-gazipur-tongi', 'route-patiya-karnaphuli', 'route-patiya-coxsbazar',
          'route-gazipur-karnaphuli', 'route-patiya-mirpur']
OFFICIAL = Path.home() / 'Desktop/fuel-simulator-reverse/src/scenarios/baseline.yaml'


def event_body(e):
    k, p = e['Kind'], {}
    if e.get('Stations'): p['station_ids'] = [STATIONS[i] for i in e['Stations']]
    if e.get('Routes'): p['route_ids'] = [ROUTES[i] for i in e['Routes']]
    if e.get('Depots'): p['depot_ids'] = [DEPOTS[i] for i in e['Depots']]
    if e.get('Fuels'): p['fuel_types'] = [FUELS[i] for i in e['Fuels']]
    if k == 'demand_spike': p['multiplier'] = e['Multiplier']
    if k == 'shipment_delay': p['delay_ticks'] = e.get('Delay', 2)
    if k == 'supply_shortfall': p['factor'] = e.get('Factor', .5)
    return dict(type=k, start_tick=e['Start'], duration_ticks=e['End'] - e['Start'], parameters=p)


def scenario_yaml(case):
    cfg, doc = case['config'], yaml.safe_load(OFFICIAL.read_text())
    doc.update(scenario_id=case['id'], seed=case['seed'])
    for d, row in zip(doc['depots'], range(2)):
        d['initial_inventory'] = dict(zip(FUELS, cfg['depot'][row]))
        d['capacity'] = dict(zip(FUELS, cfg['depot_capacity'][row]))
        d['dispatch_capacity_per_tick'] = cfg['dispatch'][row]
    for s, row in zip(doc['stations'], range(4)):
        s['initial_inventory'] = dict(zip(FUELS, cfg['stock'][row]))
        s['capacity'] = dict(zip(FUELS, cfg['capacity'][row]))
    doc['supply_arrivals'] = [dict(id=f'c-{n}', depot_id=DEPOTS[a['Depot']], fuel_type=FUELS[a['Fuel']],
                                   quantity=a['Quantity'], arrival_tick=a['Tick']) for n, a in enumerate(cfg['supplies'])]
    doc['preloaded_events'] = [event_body(e) for e in cfg['events'] if e.get('Reveal', 0) == 0]
    return yaml.safe_dump(doc, sort_keys=False)


def run(case):
    import numpy as np, torch
    from sb3_contrib import MaskablePPO
    from training.env import FuelEnv
    from training.train import choose
    torch.set_num_threads(1)
    model = MaskablePPO.load('model.zip', device='cpu')
    env = FuelEnv(horizon=case['horizon'])
    try:
        obs, _ = env.reset(seed=case['seed'], options={'fixed': True, 'config': copy.deepcopy(case['config']), 'reference_noise': True})
        ticks = []
        for _ in range(case['horizon']):
            mask = env.action_masks()
            a = choose(model, obs, mask)
            o = np.asarray(obs, dtype=np.float64)
            ticks.append(dict(a=int(a), m=int(sum(1 << i for i, v in enumerate(mask) if v)), s=float(o.sum()), n=float(np.abs(o).sum())))
            obs, _, _, _, _ = env.step(a)
        metrics = env.world.metrics()
    finally:
        env.close()
    hidden = [dict(at=e['Reveal'], body=event_body(e)) for e in case['config']['events'] if e.get('Reveal', 0) > 0]
    return case['id'], scenario_yaml(case), dict(id=case['id'], seed=case['seed'], family=case['config']['family'],
                                                inject=hidden, ticks=ticks, metrics=metrics)


if __name__ == '__main__':
    from training.evaluate import make_cases
    out, count, workers = Path(sys.argv[1]), int(sys.argv[2]) if len(sys.argv) > 2 else 200, int(sys.argv[3]) if len(sys.argv) > 3 else 4
    cases = make_cases(count, 'test')
    with Pool(workers) as pool:
        for cid, text, ref in pool.imap_unordered(run, cases):
            d = out / cid
            d.mkdir(parents=True, exist_ok=True)
            (d / 'scenario.yaml').write_text(text)
            (d / 'case.json').write_text(json.dumps(ref))
            print(cid, ref['family'], 'ship_ticks', sum(t['a'] != 0 for t in ref['ticks']), 'unmet', round(ref['metrics']['unmet']), flush=True)
