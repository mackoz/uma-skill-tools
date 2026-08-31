// Runs under plain `ts-node` -- no TS_NODE_TRANSPILE_ONLY needed. RaceSolverBuilder.ts
// used to fail ts-node's per-file typecheck on two pre-existing issues (HP-5's dead
// EnhancedHpPolicy import, PIPE-22's HorseDesc missing a `skills` field), both fixed.
//
// PIPE-21 step 2: one-race physics diff. Build all 9 horses from a single replay, pin
// every skill to activate at its recorded position (never chase RNG parity -- see
// PIPE-21's Evidence section on why the seed can't reproduce activation timing), cross-
// init them like umalator/compare.ts does with a real pair, and diff distance/speed/HP
// sampled at the replay's own (uneven) timestamps against what actually happened.
//
// Known, deliberate simplifications (report these, don't silently absorb them):
// - Only skills that the replay recorded as *activating* are added, pinned at their
//   recorded position. Equipped-but-never-fired skills are omitted entirely, rather than
//   left to the engine's own (unmatched) activation sampling -- see the "how many skills
//   got dropped" report at the end for how much this affects the field.
// - Debuffs a horse receives *from other horses'* skills are not modeled -- this harness
//   only pins each horse's own activations at Perspective.Self. Multi-uma skill targeting
//   would need reverse-engineering the target bitmask into another horse's `addSkill`
//   call, out of scope for this spike.
// - `order`/`numUmas` use the replay's actual finish order as the best available proxy
//   for the field's mid-race standings -- per ADR-0001 the engine doesn't live-read
//   standings even among simulated umas, so this is a static assumption either way.
// - mood is derived from `motivation - 3` on the game's 1..5 scale, not cross-checked
//   against `motivationCoef` -- an approximation, not verified against the engine's own
//   mood modifier table.
//
// PIPE-36: the harness itself (not the engine) previously carried ~2.3m of removable bias
// -- a dt-vs-real-tick clock drift, a post-step sampling lag, an independently-drawn start
// delay, post-finish sample contamination, and a rounded-up finish time. All five are
// fixed as of this comment (interpolated sim sampling, pinned start delay, dual-finish
// truncation, interpolated finish-line crossing) -- see that ticket's Outcome section for
// the measured before/after regression numbers. Any output from this harness now reflects
// the *fixed* measurement apparatus; don't compare it against PIPE-21-era numbers without
// accounting for this.
//
// PIPE-37: widened the reported surface for a corpus-wide accuracy report (see
// tools/replay/corpusReport.ts) without touching anything summarize() prints -- that text
// is PIPE-36's frozen regression baseline. HorseDiffResult/DiffSample are now exported,
// hpOf/currentSpeedOf/maxHpOf are exported, run() takes an optional seed override (default
// behavior unchanged -- corpusReport.ts uses it to re-seed one race under many seeds to
// estimate the sim's own run-to-run spread), and each solver now steps past its own finish
// line (if it crosses before the real horse's recorded finish time) so simDistAtRealFinish
// can be *interpolated*, never extrapolated -- see the primary-metric note at that field's
// declaration below for why this, not a time-times-speed conversion, is what umalator's own
// バ身 unit actually needs. Sample truncation (min of the two finish times) is untouched.

import * as fs from 'fs';
import * as path from 'path';

import { RaceSolverBuilder, HorseDesc } from '../../RaceSolverBuilder';
import { RaceSolver } from '../../RaceSolver';
import { GameHpPolicy } from '../../HpPolicy';
import { Strategy, Aptitude } from '../../HorseTypes';
import { CourseHelpers } from '../../CourseData';
import skillData from '../../data/skill_data.json';

import { parseReplayFile, ParsedReplay, skillTimeline, Frame, HorseFrame } from './parseReplay';

// .ground()/.weather()/.season() (RaceSolverBuilder.ts:479-490) parse a raw string themselves
// (case-insensitive, throw loudly on garbage) via parseGroundCondition/parseWeather/parseSeason
// (RaceSolverBuilder.ts:105-139) -- delegate to those instead of re-mapping by hand, so an
// unrecognized value throws instead of silently becoming undefined. The one normalization still
// needed: parseSeason only accepts "AUTUMN", not the replay's "Fall".
function normalizeSeason(season: string): string {
	return season === 'Fall' ? 'Autumn' : season;
}

function replayAptitudeToEngine(replayInt: number): Aptitude {
	// engine enum is descending (S=0..G=7); replay ints are ascending (1=G..8=S) -- confirmed
	// against hakuraku's CharaProperLabels.tsx during PIPE-21's research phase.
	return (8 - replayInt) as Aptitude;
}

// linear-interpolate a horse's distance at an arbitrary time from the replay's own frame log.
function distanceAtTime(frames: Frame[], horseIndex: number, time: number): number {
	for (let i = 0; i < frames.length - 1; i++) {
		const a = frames[i], b = frames[i + 1];
		if (b.time >= time) {
			const ratio = b.time > a.time ? (time - a.time) / (b.time - a.time) : 0;
			const da = a.horseFrame[horseIndex].distance, db = b.horseFrame[horseIndex].distance;
			return da + (db - da) * ratio;
		}
	}
	return frames[frames.length - 1].horseFrame[horseIndex].distance;
}

// interpolate the replay's own recorded distance/speed/hp for a horse at an arbitrary time
// (for comparing against the sim's state at the same wall-clock time).
function replayStateAtTime(frames: Frame[], horseIndex: number, time: number): {distance: number, speed: number, hp: number} {
	for (let i = 0; i < frames.length - 1; i++) {
		const a = frames[i], b = frames[i + 1];
		if (b.time >= time) {
			const ratio = b.time > a.time ? (time - a.time) / (b.time - a.time) : 0;
			const ha = a.horseFrame[horseIndex], hb = b.horseFrame[horseIndex];
			return {
				distance: ha.distance + (hb.distance - ha.distance) * ratio,
				speed: ha.speed + (hb.speed - ha.speed) * ratio,
				hp: ha.hp + (hb.hp - ha.hp) * ratio,
			};
		}
	}
	const last = frames[frames.length - 1].horseFrame[horseIndex];
	return {distance: last.distance, speed: last.speed, hp: last.hp};
}

// HpPolicy (RaceSolverBuilder.ts's declared type for RaceSolver.hp) lists methods only --
// `hp`/`maxHp` are fields on the GameHpPolicy *class*, and NoopHpPolicy (attached whenever
// .mode('compare') isn't set) satisfies the interface with neither field. This harness
// always sets .mode('compare'), so GameHpPolicy is guaranteed here, but read through one
// guarded accessor rather than bare `as any` casts scattered per call site (PIPE-36).
function hpOf(s: RaceSolver): number {
	return s.hp instanceof GameHpPolicy ? s.hp.hp : NaN;
}

function maxHpOf(s: RaceSolver): number {
	return s.hp instanceof GameHpPolicy ? s.hp.maxHp : NaN;
}

function currentSpeedOf(s: RaceSolver): number {
	return s.currentSpeed + s.modifiers.currentSpeed.acc + s.modifiers.currentSpeed.err;
}

function buildHorseDesc(raceHorse: any, courseSurface: number, courseDistanceType: number): HorseDesc {
	const rd = raceHorse.responseHorseData;
	const surfaceInt = courseSurface === 1 ? rd.proper_ground_turf : rd.proper_ground_dirt;
	const distInt = courseDistanceType === 1 ? rd.proper_distance_short
		: courseDistanceType === 2 ? rd.proper_distance_mile
		: courseDistanceType === 3 ? rd.proper_distance_middle
		: rd.proper_distance_long;
	const strategy = rd.running_style as Strategy;
	const styleInt = strategy === Strategy.Oonige ? rd.proper_running_style_nige // Oonige reuses the Nige aptitude, per hakuraku's TrainedCharaData.ts:55
		: strategy === Strategy.Nige ? rd.proper_running_style_nige
		: strategy === Strategy.Senkou ? rd.proper_running_style_senko
		: strategy === Strategy.Sasi ? rd.proper_running_style_sashi
		: rd.proper_running_style_oikomi;
	return {
		speed: rd.speed,
		stamina: rd.stamina,
		power: rd.pow,
		guts: rd.guts,
		wisdom: rd.wiz,
		strategy,
		distanceAptitude: replayAptitudeToEngine(distInt),
		surfaceAptitude: replayAptitudeToEngine(surfaceInt),
		strategyAptitude: replayAptitudeToEngine(styleInt),
		mood: (rd.motivation - 3) as -2 | -1 | 0 | 1 | 2,
	};
}

export interface DiffSample {
	time: number;
	simDist: number; realDist: number;
	simSpeed: number; realSpeed: number;
	simHp: number; realHp: number;
}

export interface HorseDiffResult {
	horseIndex: number;
	name: string;
	skillsInBuild: number;
	skillsActivated: number;
	skillsPinned: number;
	skillsDuplicateActivations: number; // same (horse, skillId) recorded activating >1x -- the engine has no cooldown gating between fixed-position pins, so a second pin would double-fire; dedup keeps only the first (PIPE-36)
	skillsSkippedUnregisteredCondition: string[];
	realFinishTime: number;
	simFinishTime: number | null; // null if the safety valve tripped before this horse crossed the line
	// PIPE-37: interpolated sim distance at the *real* horse's recorded finish time -- the
	// primary error metric for the corpus-wide accuracy report is
	// (simDistAtRealFinish - course.distance) / 2.5, matching what umalator itself reports
	// (posDifference / 2.5, umalator/compare.ts:608) -- a position gap at a common time, not
	// a (simFinishTime - realFinishTime) * speed conversion, which would inherit the sim's
	// own speed error and needs a speed value this harness doesn't otherwise emit. null only
	// if the safety valve tripped before simTime reached realFinishTime.
	simDistAtRealFinish: number | null;
	// Post-race sim-side state, for the corpus report's HP/spurt-timing measurements.
	// lastSpurtTransition/fullSpurt are computed lazily inside the per-step update
	// (RaceSolver.ts:1341-1350) -- reading them requires the race to have actually reached
	// that point, so these are read once after the horse stops stepping, not at build time.
	simMaxHp: number;
	// -1 has two possible causes, both legitimate: the race never reached phase 2 (shouldn't
	// happen for a full race), or -- far more commonly, verified this session at 173/180
	// corpus runs -- the horse achieved a full spurt from the phase-2 boundary itself
	// (HpPolicy.ts's getLastSpurtPair returns [-1, maxSpeed] exactly when hp >= hpNeeded for
	// the whole final stretch; simFullSpurt is true in that case). Check simFullSpurt to
	// distinguish the two before treating -1 as "never reached phase 2".
	simLastSpurtTransition: number;
	simFullSpurt: boolean;
	simNonFullSpurtDelayDistance: number | null;
	// Replay-side echoes, so one object carries the whole per-run record without a second
	// parseReplayFile() pass at the call site.
	realLastSpurtStartDistance: number;
	runningStyle: number; // HorseResult.runningStyle: 0=NONE 1=NIGE 2=SENKO 3=SASHI 4=OIKOMI
	blockedFrameCount: number;
	temptationFrameCount: number;
	temptationModeMax: number;
	realHp0: number;
	startDelayTime: number;
	realFinishOrder: number;
	samples: DiffSample[];
}

function run(replayPath: string, seedOverride?: number) {
	const {json, parsed} = parseReplayFile(replayPath);
	const courseSetId = json.raceCourseSet.id;
	const course = CourseHelpers.getCourse(courseSetId);
	const timeline = skillTimeline(parsed);

	// finish order as a static order-condition proxy (ADR-0001 -- the engine never live-reads
	// standings even among simulated umas, so a fixed assumption is unavoidable either way).
	// replay horseResult.finishOrder is 0-based; +1 for the engine's 1-based order().
	const builders: RaceSolverBuilder[] = [];
	const diffResults: HorseDiffResult[] = [];

	for (let h = 0; h < parsed.horseNum; h++) {
		const raceHorse = json.raceHorse[h];
		const desc = buildHorseDesc(raceHorse, course.surface, course.distanceType);
		const b = new RaceSolverBuilder(1)
			.seed((seedOverride ?? json.randomSeed) >>> 0) // does NOT reproduce real activation timing -- see file header
			.mode('compare') // without this the builder attaches NoopHpPolicy, not GameHpPolicy (RaceSolverBuilder.ts:879) -- HP would silently read as NaN
			.course(courseSetId)
			.ground(json.groundCondition)
			.weather(json.weather)
			.season(normalizeSeason(json.season))
			.numUmas(parsed.horseNum)
			.order(parsed.horseResult[h].finishOrder + 1, parsed.horseResult[h].finishOrder + 1)
			.horse(desc);

		const activations = timeline.get(h) || [];
		const equipped = new Set<number>((raceHorse.responseHorseData.skill_array || []).map((s: any) => s.skill_id));
		// The replay can record the same skill activating twice for one horse (observed in
		// a small number of corpus runs). addSkillAtPosition pushes an independent pending
		// activation per call, and the engine has no cross-entry cooldown gating fixed-
		// position pins against each other -- calling it twice for the same skill id
		// double-fires that skill's effects (verified empirically: two calls -> two
		// onSkillActivate callbacks at the pinned position). Dedupe before pinning and
		// count what was dropped instead of silently double-applying an effect the replay
		// only recorded once (PIPE-36).
		const pinnedSkillIds = new Set<number>();
		let duplicateActivations = 0;
		// addSkillAtPosition (RaceSolverBuilder.ts:745-748) only pushes onto an internal list --
		// condition parsing happens later, all at once, inside build()'s flatMap. It structurally
		// cannot throw here, so there is no per-skill isolation to catch: one bad condition among
		// N recorded activations fails the whole horse's build, reported below via the outer catch
		// around g.next(). Don't wrap this call in a try/catch that implies otherwise.
		for (const a of activations) {
			if (!(String(a.skillId) in (skillData as any))) continue; // shouldn't happen per PIPE-21's research, but don't crash the run
			if (pinnedSkillIds.has(a.skillId)) { duplicateActivations++; continue; }
			pinnedSkillIds.add(a.skillId);
			const pos = distanceAtTime(parsed.frame, h, a.time);
			b.addSkillAtPosition(String(a.skillId), pos);
		}

		// PIPE-37: blocked/temptation-frame counts, straight off the parsed replay -- both
		// fields exist on ParsedReplay already (parseReplay.ts's HorseFrame) but were unread
		// by this file before now.
		let blockedFrameCount = 0, temptationFrameCount = 0, temptationModeMax = 0;
		for (const f of parsed.frame) {
			const hf = f.horseFrame[h];
			if (hf.blockFrontHorseIndex !== -1) blockedFrameCount++;
			if (hf.temptationMode !== 0) temptationFrameCount++;
			if (hf.temptationMode > temptationModeMax) temptationModeMax = hf.temptationMode;
		}

		builders.push(b);
		diffResults.push({
			horseIndex: h, name: raceHorse.charaName,
			skillsInBuild: equipped.size, skillsActivated: activations.length, skillsPinned: pinnedSkillIds.size,
			skillsDuplicateActivations: duplicateActivations,
			skillsSkippedUnregisteredCondition: [],
			realFinishTime: parsed.horseResult[h].finishTimeRaw, simFinishTime: null,
			simDistAtRealFinish: null,
			simMaxHp: NaN, simLastSpurtTransition: NaN, simFullSpurt: false, simNonFullSpurtDelayDistance: null,
			realLastSpurtStartDistance: parsed.horseResult[h].lastSpurtStartDistance,
			runningStyle: parsed.horseResult[h].runningStyle,
			blockedFrameCount, temptationFrameCount, temptationModeMax,
			realHp0: parsed.frame[0].horseFrame[h].hp,
			startDelayTime: parsed.horseResult[h].startDelayTime,
			realFinishOrder: parsed.horseResult[h].finishOrder,
			samples: [],
		});
	}

	// build() is a generator; condition parsing (including the unregistered-condition-name
	// throw) happens inside it or on the generator's first .next() -- this is the one place
	// a bad skill among a horse's pinned activations can actually surface, and it fails the
	// whole horse's build, not just that one skill.
	const solvers: (RaceSolver | null)[] = builders.map((b, h) => {
		try {
			const g = b.build();
			const s = g.next().value as RaceSolver;
			// The solver draws its own startDelay (RaceSolver.ts:534, 0.1 * rng.random())
			// rather than reproducing the replay's actual draw -- an uncorrelated offset
			// that persists for the whole race (measured sd ~0.043s / ~0.93m across the
			// corpus). Overwrite with the replay's recorded value post-construction: safe
			// here since it already reflects any MultiplyStartDelay/SetStartDelay skill
			// effect applied during processSkillActivations() (PIPE-36).
			s.startDelay = parsed.horseResult[h].startDelayTime;
			s.startDelayAccumulator = s.startDelay;
			return s;
		} catch (e) {
			diffResults[h].skillsSkippedUnregisteredCondition.push(`build() failed: ${(e as Error).message}`);
			return null;
		}
	});

	solvers.forEach((s, h) => {
		if (s == null) return;
		s.initUmas(solvers.filter((s2, h2) => s2 != null && h2 !== h) as RaceSolver[]);
	});

	const dt = 1 / 15;
	// crossedFinish tracks whether this horse's own finish-line crossing (pos >= course.distance)
	// has already been detected -- distinct from "done stepping" (see stepDone below). A horse
	// that crosses its own finish line before the *real* horse's recorded finish time keeps
	// stepping past that point (PIPE-37) so simDistAtRealFinish can be interpolated instead of
	// extrapolated -- see that field's declaration for why this is the primary error metric.
	const crossedFinish = solvers.map(s => s == null);
	function stepDone(h: number): boolean {
		return solvers[h] == null || (crossedFinish[h] && diffResults[h].simDistAtRealFinish !== null);
	}
	// State at the START of the current step, per horse -- used to interpolate both the
	// sim's state at each replay sample time and the exact finish-line crossing time,
	// rather than reading a fixed post-step value. This is what actually removes the two
	// largest measured harness biases (PIPE-36): comparing `s.pos` read right after
	// `simTime += dt` against a replay time sampled mid-step was a systematic +0.72m lag,
	// and the sim's dt (1/15 = 0.0666667) silently drifting against the replay's own exact
	// 0.0666s tick was worth +1.6m of extra integrated distance by the finish. Interpolating
	// to the replay's own exact times fixes both without needing dt to match the tick.
	const before: {time: number; pos: number; speed: number; hp: number}[] = solvers.map(s => ({
		time: 0, pos: 0, speed: s ? currentSpeedOf(s) : 0, hp: s ? hpOf(s) : NaN,
	}));

	// sample the sim at the replay's own timestamps rather than assuming aligned ticks --
	// the replay is downsampled (sparse ~1.07s cadence for 97% of the race, see PIPE-21).
	let nextSampleIdx = 0;
	let simTime = 0;
	while (!solvers.every((s, h) => stepDone(h))) {
		const stepStart = simTime;
		solvers.forEach((s, h) => {
			if (stepDone(h)) return;
			before[h] = {time: stepStart, pos: s!.pos, speed: currentSpeedOf(s!), hp: hpOf(s!)};
			s!.step(dt);
		});
		simTime += dt;

		// Record the exact finish-line crossing time by interpolating within this step,
		// instead of reporting the first post-crossing tick -- the latter is a one-directional
		// +0.033s (~0.7m) bias against the replay's own (effectively exact) finishTimeRaw,
		// measured as >1% of the corpus's entire 2.99s finish-time spread (PIPE-36).
		solvers.forEach((s, h) => {
			if (s == null || crossedFinish[h]) return;
			if (s.pos >= course.distance) {
				const b = before[h];
				const ratio = s.pos > b.pos ? (course.distance - b.pos) / (s.pos - b.pos) : 0;
				diffResults[h].simFinishTime = b.time + ratio * dt;
				crossedFinish[h] = true;
			}
		});

		// PIPE-37: interpolate the sim's distance at the *real* horse's own recorded finish
		// time, the moment simTime first reaches it -- independent of whether this horse has
		// crossed its own finish line yet (a horse that finishes slower in the sim than in
		// reality reaches this before crossedFinish[h] goes true; one that finishes faster
		// reaches it in the same step crossedFinish[h] does, from the extra steps stepDone
		// keeps allowing above).
		solvers.forEach((s, h) => {
			if (s == null || diffResults[h].simDistAtRealFinish !== null) return;
			const realFinish = diffResults[h].realFinishTime;
			if (simTime >= realFinish) {
				const b = before[h];
				const ratio = simTime > b.time ? (realFinish - b.time) / (simTime - b.time) : 0;
				diffResults[h].simDistAtRealFinish = b.pos + (s.pos - b.pos) * ratio;
			}
		});

		while (nextSampleIdx < parsed.frame.length && parsed.frame[nextSampleIdx].time <= simTime) {
			const t = parsed.frame[nextSampleIdx].time;
			solvers.forEach((s, h) => {
				if (s == null) return;
				// Stop comparing a horse once EITHER side of the comparison has finished --
				// not just the sim's own finish. The old guard truncated only on the sim's
				// finish, so real post-finish run-out distance (real horses keep moving for
				// up to ~70m after crossing 1600m) got compared against a frozen sim.pos;
				// measured at 11.7% of all 21537 corpus samples, concentrated in the dense,
				// high-weight end-of-race sampling window (PIPE-36).
				const realFinish = diffResults[h].realFinishTime;
				const simFinish = diffResults[h].simFinishTime;
				if (t > realFinish) return;
				if (simFinish != null && t > simFinish) return;
				const b = before[h];
				const ratio = simTime > b.time ? (t - b.time) / (simTime - b.time) : 0;
				const simDist = b.pos + (s.pos - b.pos) * ratio;
				const simSpeed = b.speed + (currentSpeedOf(s) - b.speed) * ratio;
				const simHp = b.hp + (hpOf(s) - b.hp) * ratio;
				const real = replayStateAtTime(parsed.frame, h, t);
				diffResults[h].samples.push({
					time: t, simDist, realDist: real.distance,
					simSpeed, realSpeed: real.speed,
					simHp, realHp: real.hp,
				});
			});
			nextSampleIdx++;
		}
		if (simTime > 200) break; // safety valve
	}

	// Post-race sim-side state, read once stepping has stopped (or the safety valve tripped)
	// rather than at build time -- lastSpurtTransition/fullSpurt are computed lazily inside
	// the per-step update (RaceSolver.ts:1341-1350, updateLastSpurtState) and are only
	// meaningful once the race has actually reached that point.
	solvers.forEach((s, h) => {
		if (s == null) return;
		diffResults[h].simMaxHp = maxHpOf(s);
		diffResults[h].simLastSpurtTransition = s.lastSpurtTransition;
		diffResults[h].simFullSpurt = s.fullSpurt;
		diffResults[h].simNonFullSpurtDelayDistance = s.nonFullSpurtDelayDistance;
	});

	return diffResults;
}

function summarize(results: HorseDiffResult[]) {
	for (const r of results) {
		console.log(`\nhorse ${r.horseIndex} (${r.name}): ${r.skillsPinned}/${r.skillsActivated} activations pinned (${r.skillsInBuild} equipped total)`);
		if (r.skillsDuplicateActivations > 0) {
			console.log(`  ${r.skillsDuplicateActivations} duplicate activation(s) collapsed (engine has no cooldown gating between pins -- a second pin would double-fire, so only the first is kept)`);
		}
		if (r.skillsSkippedUnregisteredCondition.length) {
			console.log(`  skipped: ${r.skillsSkippedUnregisteredCondition.join('; ')}`);
		}
		if (r.samples.length === 0) { console.log('  (no samples -- solver failed to build)'); continue; }
		const distErrs = r.samples.map(s => s.simDist - s.realDist);
		const speedErrs = r.samples.map(s => s.simSpeed - s.realSpeed);
		const hpErrs = r.samples.map(s => s.simHp - s.realHp);
		const rms = (xs: number[]) => Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length);
		const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
		console.log(`  distance error: mean=${mean(distErrs).toFixed(2)}m rms=${rms(distErrs).toFixed(2)}m (n=${r.samples.length})`);
		console.log(`  speed error:    mean=${mean(speedErrs).toFixed(3)}m/s rms=${rms(speedErrs).toFixed(3)}m/s`);
		console.log(`  hp error:       mean=${mean(hpErrs).toFixed(1)} rms=${rms(hpErrs).toFixed(1)} (real hp0=${r.samples[0].realHp})`);
		if (r.simFinishTime != null) {
			const finishErr = r.simFinishTime - r.realFinishTime;
			console.log(`  finish time:    sim=${r.simFinishTime.toFixed(4)}s real=${r.realFinishTime.toFixed(4)}s err=${finishErr >= 0 ? '+' : ''}${finishErr.toFixed(4)}s`);
		} else {
			console.log(`  finish time:    sim never reached the finish line (safety valve tripped)`);
		}
		const last = r.samples[r.samples.length - 1];
		console.log(`  final sample (t=${last.time.toFixed(2)}): sim dist=${last.simDist.toFixed(1)} real dist=${last.realDist.toFixed(1)}`);
	}
}

if (require.main === module) {
	const file = process.argv[2];
	if (!file) { console.error('usage: ts-node replayDiff.ts <race.json>'); process.exit(1); }
	const results = run(file);
	summarize(results);
}

export { run, summarize };
