# FuelOps RL: implemented mathematics and decisions

Snapshot: 29 September 2026. Implementation commit `a81e90c9106d42389f384f24b552b323f4d3b589` in `/private/tmp/fuelops-rl.4AMWyp/repo`, branch `codex/fuelops-rl`.

This describes the implemented experiment, not every feature proposed in the earlier design. Training and held-out evaluation are separate from deployment. No learned actor is automatically promoted into the live application.

## 1. The central decision

We built **a centralized, feasible-plan selector trained with Maskable PPO and imitation warm-start**.

At each 15-minute tick:

1. Read inventory, existing shipments, visible events, and supply schedules.
2. Forecast demand using the simulator's public demand model.
3. Generate up to 12 distinct feasible dispatch plans, plus WAIT.
4. Let the policy choose one plan.
5. Validate its quantities and constraints deterministically.
6. Execute it in the offline environment; measure shortages, losses, and shipment overhead.

The neural network chooses the strategy. It does not invent arbitrary quantities, bypass constraints, or call the live simulator.

Why: this problem has a tiny fixed network but tightly coupled constraints. A shipment for one station consumes fuel and dispatch capacity that another station may need. Learning the allocation rules from penalties wastes samples and permits invalid exploration. Encoding those rules in a shared Go planner makes learning smaller and gives us a reproducible execution contract.

The deliberate ceiling: RL cannot discover a shipment plan outside the candidate family. This is not unrestricted optimal control, a Transformer, a full model-predictive controller, or proof of SOTA.

## 2. The control problem

There are two depots, four stations, three fuels, and six routes. One tick is 15 minutes; 96 ticks is one day. An experiment episode contains 576 ticks, or six simulated days.

Let:

- \(I_{sf,t}\): station \(s\)'s on-hand liters of fuel \(f\).
- \(B_{df,t}\): depot \(d\)'s available liters.
- \(P_{sf,t}\): inbound pending/in-transit liters.
- \(K_{sf}\): station capacity.
- \(C_{d,t}\): remaining depot dispatch allowance for the tick, shared across fuels.
- \(q_{rft}\): liters dispatched along route \(r\).
- \(\ell_r\): route lead time in ticks.
- \(D_{sf,t}\): demand; \(U_{sf,t}\): unmet demand.

The simulator's complete internal state includes inventories, shipments, events, and random-process state. The actor receives a compressed public observation \(o_t=\phi(s_t)\), not the simulator's random seed or hidden future events. It is therefore more precise to call this an observation-based controller than to claim the 600 features are a proven sufficient Markov state.

An action changes future inventory and routing choices. The training objective is

\[
J(\theta)=\mathbb E_{\pi_\theta}\left[\sum_{t=0}^{T-1}\gamma^t r_t\right],\qquad \gamma=0.997.
\]

That delayed consequence makes it RL rather than only a classifier. Imitation supplies an initial policy; PPO subsequently optimizes simulated returns.

We use one centralized policy because both depots and all stations share resource constraints. Independent station agents would introduce coordination and nonstationarity that this small topology does not require.

## 3. Demand forecast

The expected demand forecast is

\[
\widehat D_{sf,t+k}=\frac{\text{Daily}_{sf}}{96}\,R_s\,H_s(t+k)\,M_s(t+k).
\]

Here \(R_s\) is the simulator's regional factor, \(H_s\) its time-of-day profile, and \(M_s\) the currently active or publicly announced demand multiplier. These are simulator parameters, not a newly trained forecasting model. The nominal daily value is multiplied by the profile as implemented; we do not renormalize it to force a particular daily integral.

Actual demand adds multiplicative uniform jitter, with station-specific amplitudes 8–12%. Its mean is zero, so it is absent from the expected forecast. Future jitter is never given to the actor. Visible scheduled demand spikes apply during their inclusive event windows; active spikes are not multiplied twice.

Inventory position and estimated cover are

\[
X_{sf,t}=I_{sf,t}+P_{sf,t},\qquad
\operatorname{cover}_{sf,t}=\frac{X_{sf,t}}{\max(\frac18\sum_{k=0}^{7}\widehat D_{sf,t+k},10^{-6})}.
\]

Cover is measured in ticks. Counting inbound fuel avoids ordering the same replenishment repeatedly. Cover alone does not describe arrival timing, so the observation also includes inbound ETA buckets.

## 4. Action space: 13 choices

Action 0 is WAIT. The other actions are a Cartesian product:

| Coverage target | Urgency | Captive-station protection | Depot headroom | Scarcity-aware routing |
|---|---:|---:|---:|---:|
| 8 ticks / 2 hours | 1 | 2 | 3 | 4 |
| 24 ticks / 6 hours | 5 | 6 | 7 | 8 |
| 48 ticks / 12 hours | 9 | 10 | 11 | 12 |

For horizon \(h\), the desired order is a base-stock-style target:

\[
w_{sf}=\left[1.1\sum_{k=0}^{h-1}\widehat D_{sf,t+k}-I_{sf,t}-P_{sf,t}\right]_+.
\]

The 10% buffer is an engineering heuristic. It is not a calibrated 95% service guarantee.

The actual shipment is clipped to every relevant constraint:

\[
q=\operatorname{floor}_{0.001}\min\{w_{sf},\ K_{sf}-I_{sf,t}-P_{sf,t},\ Q_r^{\max},\ B_{df}^{\rm usable},\ C_d^{\rm left}\}.
\]

Only open, matching routes with positive feasible quantities are considered. The planner updates depot and dispatch balances after every proposed shipment. A plan has at most one shipment per station/fuel pair and at most 12 shipments. It conservatively counts all inbound fuel against tank headroom without crediting future consumption.

We leave a one-milliliter dispatch margin because the official API strictly compares floating-point sums; an apparently exact full dispatch can otherwise become `12000.000000000002` and be rejected.

The four modes are concrete heuristics:

1. **Urgency:** serve lower-cover station/fuel pairs first; prefer shorter routes.
2. **Captive protection:** prioritize Tongi and Cox's Bazar. They have only one source depot, while other stations have alternatives. Reserve their forecast deficits before allocating fuel to flexible stations.
3. **Headroom:** prioritize draining a depot that has an upcoming supply larger than its current free space. Estimated excess is \([B+\text{incoming within 24 ticks}-K^{depot}]_+\).
4. **Scarcity routing:** retain captive reserves and favor a depot with more available fuel relative to the connected stations' next-24-tick demand. Its route score is \(\ell_r-48 B^{usable}/\max(\text{connected demand},1)\).

These route scores are hand-designed rankings, not monetary costs or an exact mathematical-programming solution.

A corrected accounting detail: after the plan allocates fuel to a captive station, that allocation reduces the outstanding reserve. Otherwise we would reserve the same liters twice and unnecessarily leave usable depot fuel idle.

### Worked shipment example

Suppose a station has 1,000 L, 500 L inbound, and forecast demand of 3,000 L over the selected horizon. Desired replenishment is

\[
1.1(3000)-1000-500=1800\text{ L}.
\]

If tank headroom is 2,500 L, route maximum is 7,000 L, available depot fuel is 1,400 L, and remaining dispatch is 5,000 L, the feasible order is 1,400 L. The network cannot choose 1,800 L when only 1,400 L exists.

## 5. Observation: exactly 600 features

| Group | Count | Contents |
|---|---:|---|
| Clock | 2 | Sine/cosine of time of day |
| Stations | 164 | Open status, multiplier; stock, inbound, cover, cumulative forecasts, recent demand/unmet, arrival buckets |
| Depots | 52 | Open status, remaining dispatch; fuel availability, headroom, captive reserve, upcoming supplies |
| Routes | 18 | Availability and next visible disruption start/end |
| Candidate plans | 364 | Mask, total liters, request count, lead-time-weighted liters, each station/fuel quantity and route |
| Total | 600 | Fixed ordering and normalization |

Station/fuel features use forecasts over 4/8/24/48 ticks and arrivals within 1/2/4/8 ticks. Depot supply buckets are 4/8/24/48/96 ticks. Stock and quantity features are largely divided by capacities; all features are clipped to \([-10,10]\).

Time uses \(\sin(2\pi m/1440),\cos(2\pi m/1440)\), so 23:59 and 00:00 remain close. Plan features let the actor compare the actual quantities implied by each action, not merely memorize action IDs.

We omit random seeds, future demand realizations, hidden events, and a fabricated countdown to evaluation ending. There is no recurrent memory, learned demand forecaster, or graph encoder in this implementation.

## 6. Masked actor and critic

The actor is `600 -> 128 tanh -> 128 tanh -> 13 logits`; the critic has separate hidden layers with the same widths and one scalar output. This is about 95,117 actor parameters and 93,569 critic parameters, not a large language model.

For logits \(z_a\) and allowed-action mask \(m_a\),

\[
\pi_\theta(a\mid o,m)=\frac{m_a e^{z_a}}{\sum_j m_j e^{z_j}}.
\]

WAIT always remains allowed. In this design the planner already constructs feasible candidates; masking principally removes empty/duplicate alternatives, while validation independently enforces feasibility. Untrusted snapshots are rejected rather than made safe by softmax.

Training samples actions from this distribution. Evaluation chooses the highest-logit allowed action, using the lowest allowed ID for logits within `1e-4` of the maximum. The mask is used during evaluation too.

Action masking has a policy-gradient justification; it is not equivalent to hoping a large invalid-action penalty will eventually teach the rules. [Masking paper](https://arxiv.org/abs/2006.14171)

Why a small MLP: the topology is fixed and there are only 13 structured actions. A larger sequence/graph model adds training and integration work without an established bottleneck that requires it. This is a budget-conscious hypothesis, not a demonstrated universal architecture optimum.

## 7. Reward and its trade-offs

Define per-tick unmet liters \(U_t\), lost liters \(L_t\), number of new requests \(N_t\), and

\[
M_t=\sum_{\text{new shipments }i}q_i\ell_i.
\]

The implemented reward is

\[
r_t=-U_t/1000-L_t/1000-0.002M_t/1000-0.002N_t.
\]

Loss includes overflow and fuel lost on failed departures. The movement term is a liters-times-lead-time proxy, not measured money, distance, emissions, or actual truck utilization.

Multiplying the negative reward by 1,000 gives the undiscounted validation cost:

\[
C=U+L+0.002M+2N.
\]

Thus one extra request costs the equivalent of 2 unmet liters under this scalar objective. A 1,000 L shipment with a two-tick lead costs 4 equivalent liters for movement plus 2 for the request. If it prevents 1,000 L of unmet demand, that is strongly favorable.

Why: prioritize service and avoid waste, but discourage thousands of tiny top-ups when fewer shipments deliver comparable service. These weights are engineering choices, not learned or economically validated prices. Service is not a strict lexicographic constraint in this reward: sufficiently many saved requests can outweigh a small increase in unmet demand. Separate release checks must therefore protect service.

PPO optimizes discounted return; checkpoint selection uses the undiscounted episode cost above. Those rankings need not be identical. There is currently no explicit fairness, worst-station service, stockout-duration, or recovery-time term.

## 8. Why imitation comes first

An earlier scratch-trained pilot selected WAIT excessively under deterministic evaluation. We added a supervised warm-start using the event-aware heuristic rather than trusting more steps alone to fix that behavior.

The warm-start collects \(64\times576=36,864\) expert state/action examples and trains for 10 epochs. With action-class counts \(c_a\), weights are proportional to \(1/\sqrt{\max(c_a,1)}\). The minibatch loss is weighted cross-entropy:

\[
\mathcal L_{BC}=-\frac{\sum_i w_{a_i^*}\log\pi_\theta(a_i^*\mid o_i,m_i)}{\sum_i w_{a_i^*}}.
\]

Class weighting reduces domination by frequent WAIT labels. It does not guarantee that rare actions are good in every state. These trajectories belong to training, not validation/test. PPO then collects its own trajectories and can depart from the expert. The warm-start checkpoint remains eligible for selection if further training makes things worse.

## 9. PPO mathematics and actual settings

The critic estimates expected future discounted reward \(V_\phi(o_t)\). A temporal-difference residual is

\[
\delta_t=r_t+\gamma V_\phi(o_{t+1})-V_\phi(o_t).
\]

Generalized advantage estimation uses

\[
\widehat A_t=\sum_{l\ge0}(\gamma\lambda)^l\delta_{t+l},\qquad\lambda=0.98,
\]

with the practical sum ending at the collected rollout boundary and appropriate bootstrap handling. Advantage means better or worse than the critic expected, not absolute reward. Advantages are standardized for optimization. The critic target uses the unstandardized return estimate \(\widehat R_t=\widehat A_t+V_{old}(o_t)\).

Let

\[
\rho_t(\theta)=\frac{\pi_\theta(a_t\mid o_t,m_t)}{\pi_{old}(a_t\mid o_t,m_t)}.
\]

PPO maximizes the clipped surrogate

\[
L^{clip}=\mathbb E\left[\min\left(\rho_t\widehat A_t,\operatorname{clip}(\rho_t,0.8,1.2)\widehat A_t\right)\right].
\]

The idea is to improve actions with positive advantage without rewarding arbitrarily large probability changes on the same collected data. Clipping is not a hard global bound on policy change. [PPO paper](https://arxiv.org/abs/1707.06347)

The minimized loss combines policy, critic, and exploration terms:

\[
\mathcal L=-L^{clip}+0.5\,\mathbb E[(V_\phi-\widehat R)^2]-0.01\,H(\pi_\theta).
\]

Entropy is \(H=-\sum_a\pi(a)\log\pi(a)\) over allowed actions. Its coefficient encourages exploration, while the critic term learns the baseline used in advantage estimation.

| Setting | Actual value | Reason/trade-off |
|---|---:|---|
| Discount gamma | 0.997 | Give delayed shortages substantial weight |
| GAE lambda | 0.98 | Longer credit assignment, with more variance than a shorter trace |
| Learning rate | Constant 0.0003 | Standard starting scale; no decay is implemented |
| Clip epsilon | 0.2 | Limit incentives for overly large updates |
| Entropy coefficient | 0.01 | Preserve some exploration |
| Value coefficient | 0.5 | Balance critic fitting against actor updates |
| Gradient norm | 0.5 | Clip large gradient updates |
| Target KL | 0.02 | Trigger library early stopping of update epochs when policy change is excessive |
| Environments/seed | 8 | Parallel CPU simulation |
| Rollout/environment | 256 | 2,048 transitions collected per update |
| Minibatch size | 256 | Eight minibatches per epoch |
| Epochs/update | 4 | Up to 32 minibatch updates, fewer with KL stopping |

These are chosen settings, not the outcome of an exhaustive hyperparameter search. \(1/(1-\gamma)\approx333\) ticks is a useful discount-scale intuition, not a hard planning horizon; the discount half-life is about 231 ticks. Meanwhile \(\gamma\lambda=0.97706\), so the GAE residual weighting decays much faster than the return discount.

An episode limit is treated as truncation, not death of the fuel system. Value bootstrapping continues across this artificial boundary. A stockout does not terminate an episode. The policy is intended as a continuing controller, although the current measured evaluations cover only 576 ticks.

## 10. Simulator fidelity and accounting

An action creates orders first, deducting depot fuel immediately. The next engine pass then activates events, accepts supplies, departs pending shipments, receives arrivals, serves demand, resolves events, and increments the tick. Event ends are inclusive. A newly blocked departure can fail and lose already-deducted fuel; there is no invented refund. Existing in-transit shipments are not canceled merely because a route later closes.

After arrivals, for an open station,

\[
\text{served}_{sf,t}=\min(I_{sf,t}^{after\ arrivals},D_{sf,t}),\quad U_{sf,t}=D_{sf,t}-\text{served}_{sf,t}.
\]

During a station outage, served demand is zero even if fuel exists. Inventory is rounded as in the simulator. The conservation check is

\[
\text{initial fuel}+\text{offered supplies}
=\text{depot stock}+\text{station stock}+\text{pending/transit fuel}+\text{served fuel}+\text{lost fuel},
\]

up to explicit numerical tolerance. This catches fuel creation, disappearing fuel, and double deductions.

We compared the offline model against the official engine on all four exact scenario manifests over 576 ticks. Matching those traces is fidelity evidence for those cases, not proof of all possible events or live API behavior. In particular, the offline order batch validates atomically; live HTTP requests can partially succeed. Live reconciliation/outbox integration remains a separate gate.

## 11. Training distribution and one-hour allocation

Half the randomly sampled training episodes use one of the four exact scenario templates with fresh demand noise. The other half use randomized normal, demand-spike, route, supply, combined, or outage cases. Randomization includes starting inventories, supply availability, event time/duration, and demand multipliers. Some events are visible in advance; others are only revealed when they start.

This combines fidelity to the supplied task with variation that discourages memorizing one trajectory. It does not establish generalization to arbitrary supply networks.

The current bounded run uses seeds 11, 23, and 37, with a target of 3,000,000 transitions each: 9,000,000 total. PPO's rollout granularity may round the count slightly upward; the wall-clock guard can end a run earlier. Three seeds expose initialization/training randomness better than spending all allowed transitions on one lucky run. This is still a small seed count.

The observed GPU is an RTX 5090 despite the server's `hpc4090` name. Simulation and the shared Go planner run on CPUs; PyTorch performs the neural optimization on CUDA. Three concurrent trainers each use eight environments. GPU hardware alone does not determine throughput, and this is not a demonstrated globally fastest configuration.

The bounded sweep first chooses its comparator on validation, allows approximately 30 minutes for concurrent training, and reserves time for frozen held-out evaluation. It stops on the time budget rather than claiming 10M steps were completed merely because requested.

## 12. Baselines, selection, and statistics

We compare the event-aware greedy controller with all 12 fixed candidate preferences, using the same forecasts, constraints, and public information. Greedy has reorder hysteresis: it normally waits until cover is low enough to justify replenishment, prepositions for announced route closures, and makes room for incoming supply. A shortage that cannot actually be supplied does not trigger unnecessary top-ups elsewhere.

The comparator is selected on 20 validation cases using \(C=U+L+0.002M+2N\). In the current run the selected comparator is greedy. This is the strongest of the tested heuristic candidates under that validation objective, not proof it beats every optimization algorithm.

Each seed's warm-start and periodic PPO checkpoints are also compared on the fixed 20-case validation set. Validation runs every 262,144 transitions; the selected checkpoint receives a final 40-case validation. The last training checkpoint is not automatically considered best. Repeated use of a small validation set can overfit it; the held-out result is essential.

After checkpoint selection, each policy is tested on 200 frozen cases with the same exogenous demand/events for each policy, plus four exact-manifest replays reported separately. Validation and test random seeds are disjoint, but they share scenario families/templates. This is not an unseen-template or unseen-topology test.

Service level is

\[
SL=\frac{\text{served}}{\text{served}+\text{unmet}}.
\]

The report averages per-case service levels; it is not necessarily the pooled ratio across cases. For case \(i\), paired unmet improvement is

\[
\Delta_i=U_i^{baseline}-U_i^{RL};\qquad\overline\Delta=\frac1n\sum_i\Delta_i.
\]

Positive means RL reduced unmet liters. We resample whole paired cases 2,000 times and report the 2.5th/97.5th percentiles of the bootstrap mean. We do not pretend the correlated ticks within an episode are independent observations. These intervals measure scenario variation conditional on a trained policy; they do not fully capture uncertainty across training seeds. [RL evaluation guidance](https://arxiv.org/abs/2108.13264)

Test performance is not used to choose a checkpoint or retune the algorithm. There is no automatic promotion even if a number looks good.

## 13. Why more training may not improve aggregate service

Fuel conservation sets a hard ceiling. If all available usable fuel is already served, no controller can create additional liters. In exact scarce-supply replays the improved heuristic served essentially all usable fuel. The remaining opportunity may therefore be fewer requests at comparable service, improved timing, or different distribution between stations—not a large aggregate-service gain.

For example, the exact demand-spike baseline went from 988 requests to 147 while retaining 394,900 served liters after fixing the heuristic's unnecessary shipment churn. That is a baseline engineering improvement, not an RL result. The learned policy must beat the improved comparator, not an obsolete weak one.

## 14. What remains unproven

- SOTA superiority: no exhaustive external benchmark, MPC/stochastic-programming comparison, or global optimum certificate.
- A statistically reliable benefit over the improved heuristic: pending the current frozen held-out evaluation.
- Generalization to longer/variable horizons, unseen templates, or different topology.
- Fairness, per-station recovery, and operational economic value; these are not current optimized/reporting guarantees.
- Exported Go actor parity, live write reconciliation, deployment, and user-visible end-to-end model execution.

The defensible claim today is: **we implemented a constrained hybrid RL experiment, tested its simulator/planner contract, strengthened its baseline, and are measuring whether learning adds value.** A larger step count alone does not change that evidence boundary.

## Source map

- `backend/internal/planner/planner.go`: forecasts, candidates, constraints, features, baseline.
- `training/world.py`: simulator transitions, scenario randomization, reward, conservation.
- `training/env.py`: Gymnasium actions, masks, observations, truncation.
- `training/train.py`: warm-start, Maskable PPO, metrics, checkpoint selection.
- `training/evaluate.py`: frozen cases, paired comparisons, bootstrap.
- `training/sweep.py`: bounded multi-seed execution and final evaluation.

The running code is frozen for this batch; this explanation does not change its hyperparameters or training data.
