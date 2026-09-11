// SKL-21: measures how often a skill with an in-game cooldown actually activates more than once,
// from real replays and from the simulator, so the two can be compared. The "discrete" family
// (all_corner_random/straight_random/is_finalcorner_random) reporting zero on course 10903 is the
// pass/fail check for the cooldown gate -- but the two halves of that bucket carry very different
// weight now. Course 10903's corners span roughly 450m-1127m (~31s at corpus pace), and cooldown is
// distance-scaled (Cooldown = BaseCooldown * distance/1000): on this 1600m course that's 48s, which
// outlasts the ~31s corner span, so a second all_corner_random proc within one pass of the corners
// is geometrically impossible on this course -- NOT because corners "sit inside one 30s window" (an
// earlier, wrong version of this comment, and the reason the original check failed: it assumed an
// unscaled 30s cooldown against a rougher ~570m corner-span estimate that didn't match course
// 10903's actual geometry). The straight half of this bucket isn't really doing pass/fail work any
// more either way: straight_random skills get zero spares by construction (see
// RaceSolverBuilder.ts@skl-21-spares-count and samplePolicyPlacesMultiplePoints()), so they can
// never re-arm regardless of any course's geometry -- a straight_random re-trigger appearing here
// would mean the spares restriction itself broke, not a cooldown/geometry interaction.
import * as fs from 'fs';
import * as path from 'path';
import { parseReplayFile, skillTimeline } from './parseReplay';
import { buildHorseFromReplay } from './replayDiff';
import { RaceSolverBuilder, Perspective } from '../../RaceSolverBuilder';
import { RaceSolver } from '../../RaceSolver';
import skillData from '../../data/jp/skill_data.json';

type Family = 'discrete' | 'distribution' | 'other';

function family(skillId: string): Family {
	const entry = (skillData as any)[skillId];
	if (entry == null) return 'other';
	const cond = entry.alternatives.map((a: any) => a.condition).join('@');
	if (/all_corner_random|straight_random|is_finalcorner_random/.test(cond)) return 'discrete';
	// NB. `accumulatetime` alone resolves to ImmediatePolicy (0 spares) and cannot re-trigger on its
	// own -- it only re-arms when ANDed with one of the conditions below, in which case `cond`
	// already contains that condition's name too. So `accumulatetime` is deliberately absent from
	// this regex: including it would misclassify an accumulatetime-only skill (which structurally
	// can't re-trigger) as belonging to the family that can. See README.md's "Skill cooldowns"
	// section and CLAUDE.md's engine-behavior bullet for the authoritative statement of this.
	if (/near_lane_time|change_order_onetime|blocked_/.test(cond)) return 'distribution';
	return 'other';
}

// Task 1 made skill_data.json the authoritative source for "has a cooldown" -- no sqlite needed.
function hasCooldown(skillId: string): boolean {
	const entry = (skillData as any)[skillId];
	return entry != null && entry.alternatives.some((a: any) => 'cooldown' in a);
}

interface Tally {
	skills: Set<string>;
	procs: number;
	retriggers: number;
	gaps: number[];
}

function emptyTally(): Tally {
	return {skills: new Set(), procs: 0, retriggers: 0, gaps: []};
}

// activations: (horse, skillId) -> ascending activation times, for one race
export function tallyRace(byHorseSkill: Map<string, number[]>, into: Map<Family, Tally>) {
	for (const [key, times] of byHorseSkill) {
		const skillId = key.slice(key.indexOf(':') + 1);
		if (!hasCooldown(skillId)) continue;
		const f = family(skillId);
		const t = into.get(f)!;
		t.skills.add(skillId);
		t.procs += times.length;
		for (let i = 1; i < times.length; ++i) {
			t.retriggers++;
			t.gaps.push(times[i] - times[i - 1]);
		}
	}
}

export function report(label: string, tallies: Map<Family, Tally>) {
	console.log(label);
	for (const f of ['discrete', 'distribution', 'other'] as Family[]) {
		const t = tallies.get(f)!;
		if (t.skills.size === 0) continue;
		const gaps = t.gaps.length > 0
			? ` gaps ${Math.min(...t.gaps).toFixed(2)}s..${Math.max(...t.gaps).toFixed(2)}s`
			: '';
		console.log(`  ${f.padEnd(12)} ${t.skills.size} skills present, ${t.procs} procs, ${t.retriggers} re-triggers${gaps}`);
	}
}

function replayMode(dir: string) {
	const tallies = new Map<Family, Tally>([['discrete', emptyTally()], ['distribution', emptyTally()], ['other', emptyTally()]]);
	let races = 0, horseRuns = 0;
	for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
		let parsed;
		try { ({parsed} = parseReplayFile(path.join(dir, f))); } catch { continue; }
		races++;
		const byHorseSkill = new Map<string, number[]>();
		for (const [horseIndex, acts] of skillTimeline(parsed)) {
			horseRuns++;
			for (const a of acts) {
				const key = `${horseIndex}:${a.skillId}`;
				if (!byHorseSkill.has(key)) byHorseSkill.set(key, []);
				byHorseSkill.get(key)!.push(a.time);
			}
		}
		tallyRace(byHorseSkill, tallies);
	}
	report(`replays: races=${races} horse-runs=${horseRuns}`, tallies);
}

function simMode(dir: string) {
	const tallies = new Map<Family, Tally>([['discrete', emptyTally()], ['distribution', emptyTally()], ['other', emptyTally()]]);
	let races = 0, horseRuns = 0;
	for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
		let json: any, parsed;
		try { ({json, parsed} = parseReplayFile(path.join(dir, f))); } catch { continue; }
		races++;
		const byHorseSkill = new Map<string, number[]>();

		// SKL-21 deviation from the brief's literal sketch: the sketch builds and steps one
		// isolated horse at a time, never calling initUmas. That leaves `this.umas` at its
		// built-in default of `[]` (RaceSolver.ts:530) -- no blocking, no position-keep
		// slowing, no spot-struggle against the other 8 horses, all of which affect *when*
		// a horse crosses a corner/straight region and therefore whether a 30s-cooldown
		// skill's condition window reopens before the race ends. An isolated-horse first pass
		// produced corner-family (all_corner_random) re-triggers that the real corpus never
		// shows even once in 475 procs -- building the whole field together and wiring
		// initUmas, exactly as run() does, removes them (see task-6-report.md). This also
		// means a horse whose build fails no longer silently drops just that horse: the whole
		// race's solvers array still needs one slot per horse for initUmas's cross-references,
		// so a null build stays in the array (mirroring run()'s own solvers.map pattern) and
		// every other horse in the race is filtered to exclude it when initializing.
		//
		// buildHorseFromReplay (faithfully extracted from run()'s pre-pinning code) attaches
		// zero skills -- replayDiff.ts never builds a horse's full condition-driven skill set,
		// only ever pins what the replay recorded as having fired (see this file's own header
		// comment). Equip each horse's actual loadout (responseHorseData.skill_array) as
		// condition-driven skills so the engine's own sampling has something to fire, matching
		// the stated intent ("let the engine place its own triggers from conditions").
		const builders: (RaceSolverBuilder | null)[] = [];
		for (let h = 0; h < parsed.horseNum; h++) {
			let builder: RaceSolverBuilder | null;
			try { builder = buildHorseFromReplay(json, parsed, h); } catch { builders.push(null); continue; }
			const equipped: number[] = (json.raceHorse[h].responseHorseData.skill_array || []).map((s: any) => s.skill_id);
			for (const id of equipped) {
				if (!(String(id) in (skillData as any))) continue;
				builder.addSkill(String(id), Perspective.Self);
			}
			// onSkillActivate fires once per activation, so a re-armed skill records twice --
			// which is exactly the signal being measured. Time, not position, to match the
			// replay side.
			builder.onSkillActivate((solver, skillId) => {
				const key = `${h}:${skillId}`;
				if (!byHorseSkill.has(key)) byHorseSkill.set(key, []);
				byHorseSkill.get(key)!.push(solver.accumulatetime.t);
			});
			builders.push(builder);
		}

		// Condition parsing (including the unregistered-condition-name throw replayDiff.ts's
		// own run() guards against) happens inside build()/the generator's first .next() --
		// with a horse's full loadout now attached, an unregistered condition among the
		// equipped-but-never-fired skills can surface here where it couldn't when only
		// replay-observed activations were pinned. Skip that horse (not the whole race) rather
		// than crash the run, same posture as run()'s own per-horse try/catch.
		const solvers: (RaceSolver | null)[] = builders.map(b => {
			if (b == null) return null;
			try {
				const gen = b.build();
				return gen.next().value as RaceSolver;
			} catch { return null; }
		});
		solvers.forEach((s, h) => {
			if (s == null) return;
			s.initUmas(solvers.filter((s2, h2) => s2 != null && h2 !== h) as RaceSolver[]);
			horseRuns++;
		});

		// dt, the course-distance finish check, and the 200s safety valve match
		// replayDiff.run()'s own stepping loop -- deliberately not a second convention, per
		// SKL-21's task brief. Every solver steps together, in lockstep, rather than one horse
		// at a time, so the cross-horse state initUmas wires up (blocking, position-keep,
		// spot struggle) stays live for the whole race.
		const dt = 1 / 15;
		let simTime = 0;
		while (solvers.some(s => s != null && s.pos < s.course.distance)) {
			for (const s of solvers) {
				if (s != null && s.pos < s.course.distance) s.step(dt);
			}
			simTime += dt;
			if (simTime > 200) break; // safety valve, same threshold as run()
		}

		tallyRace(byHorseSkill, tallies);
	}
	report(`simulated: races=${races} horse-runs=${horseRuns}`, tallies);
}

function main() {
	const args = process.argv.slice(2);
	const sim = args[0] === '--sim';
	const dir = sim ? args[1] : args[0];
	if (!dir) {
		console.error('usage: tsx cooldownReport.ts [--sim] <replay-dir>');
		process.exit(1);
	}
	if (sim) simMode(dir); else replayMode(dir);
}

main();
