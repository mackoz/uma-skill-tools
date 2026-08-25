# uma-skill-tools

Tools and libraries for simulating races in ウマ娘 プリティーダービー and analyzing skill effects. See the readme in the tools/ folder for usage of the command-line tools.

**This is [`mackoz/uma-skill-tools`](https://github.com/mackoz/uma-skill-tools), a fork of [`alpha123/uma-skill-tools`](https://github.com/alpha123/uma-skill-tools)** — it's the engine submodule for [`mackoz/uma-tools`](https://github.com/mackoz/uma-tools) (a browser-based race simulator built on top of this library), referenced the same way `alpha123/uma-tools` references `alpha123/uma-skill-tools`.

Setup:

```
git clone https://github.com/mackoz/uma-skill-tools.git
cd uma-skill-tools
npm install
npm test
```

This installs `ts-node` and runs the currently wired tests: `test/parser.ts` (a condition-parser property test) and `test/activation-sampling.ts` (sample-policy bounds and derived-seed isolation). See `CLAUDE.md` and `tools/README.md` for the standalone typecheck and the current status of the older CLI tools.

Charting features require Python and matplotlib.

# Design

Broadly, the framework is divided into two parts:

- Simulating a race
- Parsing skill conditions and turning them into points on a course where the skill will activate

The former is mostly contained in RaceSolver.ts, which numerically integrates your position and velocity over the course of a race. It is provided with effects that activate at specified times, which is used to implement skills. Activation is controlled by *static conditions* or a *trigger*, which is just a region on the track, and *dynamic conditions*, which is a boolean function dependent on the state of the race solver. Once a trigger is entered, the corresponding dynamic conditions are checked and if they return true the effect is activated for a specified duration.

The latter part is responsible for taking skill data mined from the game and generating the triggers and dynamic conditions. It can be further subdivided into two parts:

- ConditionParser.ts and ActivationConditions.ts, which parse the skill conditions into a tree and, given a course, reduce that to a list of regions on the course where the skill has the *potential* to activate, and its dynamic conditions (if any).
- ActivationSamplePolicy.ts, which samples the list of regions to determine triggers for where the skill will actually activate. Since many skills are either random or modeled as random, many samples are supposed to be taken and the race solver ran many times with different sampled trigger points.

Each skill condition has an associated *sample policy* such as immediate, random (of various types), or random according to a particular probability distribution. Immediate means all samples are the earliest point in their allowable regions, for example phase>=2 is immediate and all samples will be the start of phase 2. The difference between the two random types is the former is used for actually random conditions (i.e., ones that end in \_random, like phase_random, all_corner_random, etc) and the latter is used for conditions that are not actually random but involve other umas in some way and so are modeled as random. When skill conditions are combined with & or @ some sample policies dominate other ones, so something like is_lastspurt==1&phase_random==3 will be sampled randomly (is_lastspurt==1 would otherwise always be sampled as activating immediately).

The sample policy associated with a condition is more of just a default and technically the output of any condition tree can be sampled with any sample policy. This is intended to allow the user some choice in how certain conditions are modeled, since the sample policy is what controls where a given skill is "likely" to activate.

# Decision records

Significant design decisions — modeling approximations, numeric-output-affecting choices, failure-handling posture — are recorded as ADRs in [`docs/adr/`](docs/adr/README.md), including reconstructed rationale for decisions inherited from alpha123 and the kachi lineage. If you're about to "fix" something surprising (the RNG shim, the probability stand-ins for field conditions, the loud unknown-condition errors), read the matching record first; if you're about to make a decision like that, add one.

# Behavior notes

## Whole-field simulation, position keep, and lane changes

This engine simulates the whole field (`initUmas()`, a `RaceSolver[]` per uma, `getPacer()` re-electing the pacemaker every frame), with a real 5-state position-keep machine (`PositionKeepState {None, PaceUp, PaceDown, SpeedUp, Overtake}`), real lane-change movement (`applyLaneMovement()`, `LaneMovementSpeed`/`ChangeLane` skill types), and real lead-competition/dueling mechanics (`updateCompeteFight()`/`updateLeadCompetition()`). `order`/`order_rate` conditions are checked against a real placement rather than assumed always-satisfied — but that placement is still the fixed, user-supplied `extra.orderRange` (`orderFilter`/`orderInFilter`/`orderOutFilter`, `ActivationConditions.ts`), not a live read of the simulated field's actual standings each frame.

Many multi-uma-dependent conditions still can't be simulated literally even with a full field (things like real overtake-mode targeting still need actual multi-uma race-replay data this engine doesn't have) — those are modeled by runtime Markov-chain approximations (`ApproximateConditions.ts`, `SpecialConditions.ts`) rather than static pre-race probability distributions.

## Skills that combine `accumulatetime` with a condition modeled by a probability distribution may still activate too early

Because only one region is selected as the trigger, if the dynamic condition isn't satisfied there the skill fails to activate even though it would have in a later region — so these skills tend to activate right after the `accumulatetime` threshold is met, more often than the modeled distribution predicts.

This engine's `accumulatetime` handling (`ActivationConditions.ts`) statically trims regions to an estimated arrival window (`0.85 * baseSpeed * t`) applied uniformly, with no exemption list for affected skills.

## Downhill mode and kakari (Rushed) are implemented

Downhill speedup mode and kakari (掛かり, called "Rushed" in Global) are both implemented (`downhillCheck()`/`isDownhillMode` in `RaceSolver.ts`, wisdom-gated per a `WizStat * 0.04%` roll; `isRushed`/`rushedSection` for kakari, covering a 2–9 section range with a 自制心 skill exception). The skill-condition layer is wired to this state too — `is_temptation`/`temptation_count` read real `isRushed`/`hasBeenRushed` values instead of no-op'ing. A related naming bug is also fixed: 4 skills use a condition literally named `running_style_temptation_opponent_count_*`, which used to be registered without "opponent" — that mismatch crashed skill-build for any of those 4; renamed to match, still a mocked value pending real multi-uma opponent tracking.

## Unknown skill conditions now fail loudly, by name

Same naming-mismatch bug class as the `running_style_temptation_opponent_count_*` fix above, but broader: `ConditionParser.ts`'s `Identifier.nud` used to resolve an unrecognized condition name to `undefined` with no bounds check, so the first comparison built against it (`new EqOperator(undefined, 1)`, etc.) threw `TypeError: Cannot read properties of undefined (reading 'samplePolicy')` at skill-build time — a real crash, not a no-op, for any shipped skill referencing a condition this engine doesn't register. It now throws a named `ParseError: unknown condition: <name>` instead, so the failure is diagnosable rather than a bare `TypeError` pointing at unrelated internals.

Four condition names that were hitting exactly this crash are now real implementations instead of missing entirely: `is_activate_any_skill` (extended to also count skills forced via `doActivateRandomGold`/Adventure of 564), `order_rate_in50_continue` (one-line addition to the existing `orderInFilter`/`orderOutFilter` family — same static-`orderRange` caveat as the rest of that family, see above), `last_straight_random` (built the same way as `phase_straight_random`/`is_last_straight`, just without the phase bounds), and `activate_count_later_half` (a new `activateCountLaterHalf` counter on `RaceState`, incremented for `pos >= course.distance / 2`).

Eighteen condition names used by shipped skills remain unregistered and will still throw the new named `ParseError`: three that ship on Global too — `temptation_opponent_count_behind`/`temptation_opponent_count_infront` and `is_other_character_activate_advantage_skill` — plus fifteen JP-only names (`fan_count`, `furlong`, `is_abroad`, `is_activate_heal_skill`, `is_exist_skill_id`, `is_goodstart`, `is_popularity_top_character_activate_advantage_skill`, `is_used_skill_id_with_detail_one`, `near_infront_count`, `phase_first_half_straight_random`, `phase_laterhalf`, `phase_latter_half_straight_random`, `run_at_full_speed_random`, `succession_skill_count`, `up_slope_random_later_half` — the last four newly observed in this refresh's `master-jp.mdb`, tracked in plans' SKL-24).

## Scaling effects are not implemented

The value-scaling (1–25), duration-scaling (1–7), and skill-level (1–10) tables aren't modeled — the per-skill values used are whatever the data pipeline extracted for whatever level/scaling state that data happens to reflect, not a selectable parameter.

## Skill cooldowns

Skills can only activate once per simulated race; skills with an in-game cooldown (弧線のプロフェッサー, ハヤテ一文字, etc.) aren't re-triggered.

# Credit

English skill names are from [GameTora](https://gametora.com/umamusume).

KuromiAK#4505 on Discord let me hassle him about various minutiae of game mechanics.

Multi-uma simulation, position keep, lane movement, and lead competition/dueling are from [Werseter/uma-skill-tools](https://github.com/Werseter/uma-skill-tools) (the `kachi` branch), imported here to bring this fork's engine in line with what [`mackoz/uma-tools`](https://github.com/mackoz/uma-tools) actually runs.

# License

Copyright (C) 2022  pecan

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
