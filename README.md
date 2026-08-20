# uma-skill-tools

Tools and libraries for simulating races in ウマ娘 プリティーダービー and analyzing skill effects. See the readme in the tools/ folder for usage of the command-line tools.

**This is [`mackoz/uma-skill-tools`](https://github.com/mackoz/uma-skill-tools), a fork of [`alpha123/uma-skill-tools`](https://github.com/alpha123/uma-skill-tools)** — it's the engine submodule for [`mackoz/uma-tools`](https://github.com/mackoz/uma-tools) (a browser-based race simulator built on top of this library), referenced the same way `alpha123/uma-tools` references the upstream engine. Most of what's different from upstream here was imported from [`Werseter/uma-skill-tools@kachi`](https://github.com/Werseter/uma-skill-tools/tree/kachi) — see [`mackoz/uma-tools`'s `plans/engine-comparison/forks.md`](https://github.com/mackoz/uma-tools-plans/blob/main/engine-comparison/forks.md) for the detailed comparison and attribution this README doesn't try to duplicate.

Setup:

```
git clone https://github.com/mackoz/uma-skill-tools.git
cd uma-skill-tools
npm install --dev
```

This will install `ts-node`, which you can use to run the CLI tools.

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

# Caveats

Upstream's original README described a deliberately narrower engine than this fork now is — several of its caveats no longer apply here and are corrected below. Where a caveat is now false, the "why" behind the original design choice is kept (it's still useful context for *why* upstream is architected the way it is), with a note on what this fork actually does instead.

## Whole-field simulation, position keep, and lane changes

Upstream's original design point: simulating one uma in isolation, with other umas' conditions modeled as probability distributions, keeps the environment controlled enough to isolate a single skill's distance gain — full multi-uma simulation makes that isolation harder. That's still upstream's tradeoff.

**This fork doesn't make that tradeoff.** It simulates the whole field (`initUmas()`, a `RaceSolver[]` per uma, `getPacer()` re-electing the pacemaker every frame — from `Werseter/uma-skill-tools@kachi`), with a real 5-state position-keep machine (`PositionKeepState {None, PaceUp, PaceDown, SpeedUp, Overtake}`, not just pace-down-at-the-start), real lane-change movement (`applyLaneMovement()`, `LaneMovementSpeed`/`ChangeLane` skill types), and real lead-competition/dueling mechanics (`updateCompeteFight()`/`updateLeadCompetition()`). `order`/`order_rate` conditions are evaluated against the actual simulated field rather than assumed always-satisfied.

Many multi-uma-dependent conditions still can't be simulated literally even with a full field (things like real overtake-mode targeting still need actual multi-uma race-replay data this engine doesn't have) — those remain modeled by runtime Markov-chain approximations (`ApproximateConditions.ts`, `SpecialConditions.ts`) rather than static pre-race probability distributions, which is a different approximation strategy than upstream's, not a return to upstream's static-stub approach.

## Skills that combine `accumulatetime` with a condition modeled by a probability distribution may still activate too early

Upstream's original bug report: because only one region is selected as the trigger, if the dynamic condition isn't satisfied there the skill fails to activate even though it would have in a later region — so these skills tend to activate right after the `accumulatetime` threshold is met, more often than the modeled distribution predicts.

This fork's `accumulatetime` handling (`ActivationConditions.ts`) statically trims regions to an estimated arrival window (`0.85 * baseSpeed * t`) applied uniformly, with no exemption list for affected skills — the same general shape of issue upstream described is plausibly still present here, but the specific skill list from upstream's README (ウマ好み/ウママニア, 先頭プライド/トップランナー, etc.) hasn't been re-verified against this fork's current condition set and isn't repeated here as fact. Worth checking against `mackoz/uma-tools`'s `plans/engine-comparison/skills.md#skl-2` before relying on either the old list or the assumption that it's fixed.

## Downhill mode and kakari (Rushed) are implemented, not planned

Upstream's original "Not yet implemented" list included downhill speedup mode and kakari (掛かり, called "Rushed" in Global) — both **are implemented** in this fork (`downhillCheck()`/`isDownhillMode` in `RaceSolver.ts`, wisdom-gated per the doc's `WizStat * 0.04%` roll; `isRushed`/`rushedSection` for kakari, including the doc's 2–9 section range and the 自制心 skill exception). The skill-condition layer is wired to this state too — `is_temptation`/`temptation_count` read real `isRushed`/`hasBeenRushed` values instead of no-op'ing (they used to, despite the state machine existing). A related naming bug is also fixed: 4 skills use a condition literally named `running_style_temptation_opponent_count_*`, which this fork (and upstream B) had registered without "opponent" — that mismatch crashed skill-build for any of those 4; renamed to match, still a mocked value pending real multi-uma opponent tracking.

## Scaling effects are not implemented

Still true. The doc's value-scaling (1–25), duration-scaling (1–7), and skill-level (1–10) tables aren't modeled — the per-skill values used are whatever the data pipeline extracted for whatever level/scaling state that data happens to reflect, not a selectable parameter.

## Skill cooldowns

Still true. Skills can only activate once per simulated race; skills with an in-game cooldown (弧線のプロフェッサー, ハヤテ一文字, etc.) aren't re-triggered.

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
