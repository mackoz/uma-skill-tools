// Run with TS_NODE_TRANSPILE_ONLY=1 (RaceSolverBuilder.ts currently fails a strict
// ts-node per-file typecheck on two pre-existing, unrelated issues -- HP-5's dead
// EnhancedHpPolicy import, and a second, newly-found issue where HorseDesc's declared
// type is missing a `skills` field that setupPacer() reads and production callers
// always supply in practice; see the new ticket this session filed alongside HP-5).
// Neither is a real runtime bug in the path this script exercises (no pacer is built
// here), so transpile-only is a safe, minimal workaround, not a masked failure.
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

import * as fs from 'fs';
import * as path from 'path';

import { RaceSolverBuilder, HorseDesc } from '../../RaceSolverBuilder';
import { RaceSolver } from '../../RaceSolver';
import { Strategy, Aptitude } from '../../HorseTypes';
import { GroundCondition, Weather, Season } from '../../RaceParameters';
import { CourseHelpers } from '../../CourseData';
import skillData from '../../data/skill_data.json';

import { parseReplayFile, ParsedReplay, skillTimeline, Frame, HorseFrame } from './parseReplay';

const GROUND_MAP: Record<string, GroundCondition> = {Good: GroundCondition.Good, Yielding: GroundCondition.Yielding, Soft: GroundCondition.Soft, Heavy: GroundCondition.Heavy};
const WEATHER_MAP: Record<string, Weather> = {Sunny: Weather.Sunny, Cloudy: Weather.Cloudy, Rainy: Weather.Rainy, Snowy: Weather.Snowy};
const SEASON_MAP: Record<string, Season> = {Spring: Season.Spring, Summer: Season.Summer, Fall: Season.Autumn, Autumn: Season.Autumn, Winter: Season.Winter, Sakura: Season.Sakura};

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

interface HorseDiffResult {
	horseIndex: number;
	name: string;
	skillsInBuild: number;
	skillsActivated: number;
	skillsPinned: number;
	skillsSkippedUnregisteredCondition: string[];
	samples: {time: number; simDist: number; realDist: number; simSpeed: number; realSpeed: number; simHp: number; realHp: number}[];
}

function run(replayPath: string) {
	const {json, parsed} = parseReplayFile(replayPath);
	const courseSetId = json.raceCourseSet.id;
	const course = CourseHelpers.getCourse(courseSetId);
	const ground = GROUND_MAP[json.groundCondition];
	const weather = WEATHER_MAP[json.weather];
	const season = SEASON_MAP[json.season];
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
			.seed(json.randomSeed >>> 0) // does NOT reproduce real activation timing -- see file header
			.mode('compare') // without this the builder attaches NoopHpPolicy, not GameHpPolicy (RaceSolverBuilder.ts:879) -- HP would silently read as NaN
			.course(courseSetId)
			.mood(desc.mood)
			.ground(ground)
			.weather(weather)
			.season(season)
			.numUmas(parsed.horseNum)
			.order(parsed.horseResult[h].finishOrder + 1, parsed.horseResult[h].finishOrder + 1)
			.horse(desc);

		const activations = timeline.get(h) || [];
		const equipped = new Set<number>((raceHorse.responseHorseData.skill_array || []).map((s: any) => s.skill_id));
		let pinned = 0;
		const skippedUnregistered: string[] = [];
		for (const a of activations) {
			if (!(String(a.skillId) in (skillData as any))) continue; // shouldn't happen per PIPE-21's research, but don't crash the run
			const pos = distanceAtTime(parsed.frame, h, a.time);
			try {
				// verify addSkillAtPosition doesn't throw at build time (unregistered condition names etc)
				b.addSkillAtPosition(String(a.skillId), pos);
				pinned++;
			} catch (e) {
				skippedUnregistered.push(`${a.skillId}: ${(e as Error).message}`);
			}
		}

		builders.push(b);
		diffResults.push({
			horseIndex: h, name: raceHorse.charaName,
			skillsInBuild: equipped.size, skillsActivated: activations.length, skillsPinned: pinned,
			skillsSkippedUnregisteredCondition: skippedUnregistered, samples: [],
		});
	}

	// build() is a generator; addSkillAtPosition may only actually throw when the generator
	// is driven (condition parsing happens at build-time inside the skill-data lookup, but
	// activation-window construction can defer errors to first .next()) -- guard both points.
	const solvers: (RaceSolver | null)[] = builders.map((b, h) => {
		try {
			const g = b.build();
			return g.next().value as RaceSolver;
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
	const finished = solvers.map(s => s == null);
	// sample the sim at the replay's own timestamps rather than assuming aligned ticks --
	// the replay is downsampled (sparse ~1.07s cadence for 97% of the race, see PIPE-21).
	let nextSampleIdx = 0;
	let simTime = 0;
	while (!finished.every(f => f)) {
		solvers.forEach((s, h) => {
			if (s == null || finished[h]) return;
			if (s.pos >= course.distance) { finished[h] = true; return; }
			s.step(dt);
		});
		simTime += dt;
		while (nextSampleIdx < parsed.frame.length && parsed.frame[nextSampleIdx].time <= simTime) {
			const t = parsed.frame[nextSampleIdx].time;
			solvers.forEach((s, h) => {
				if (s == null || finished[h]) return; // don't compare a frozen finished sim.pos against real post-finish run-out distance
				const real = replayStateAtTime(parsed.frame, h, t);
				diffResults[h].samples.push({
					time: t, simDist: s.pos, realDist: real.distance,
					simSpeed: s.currentSpeed + s.modifiers.currentSpeed.acc + s.modifiers.currentSpeed.err, realSpeed: real.speed,
					simHp: (s.hp as any).hp ?? NaN, realHp: real.hp,
				});
			});
			nextSampleIdx++;
		}
		if (simTime > 200) break; // safety valve
	}

	return diffResults;
}

function summarize(results: HorseDiffResult[]) {
	for (const r of results) {
		console.log(`\nhorse ${r.horseIndex} (${r.name}): ${r.skillsPinned}/${r.skillsActivated} activations pinned (${r.skillsInBuild} equipped total)`);
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
