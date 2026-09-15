// PIPE-21 step 1 (measurement pass): cross-check the engine's downhill accel-mode HP
// and speed effects against real replay data, using hakuraku's own HP-drain-based
// detector so the detection doesn't depend on the speed effect being measured. No
// simulator run -- pure corpus measurement over a directory of decoded replays.
//
// Settles (partially) SPD-7 -- see that ticket for the two competing formulas this
// was built to distinguish. Run: `npx tsx tools/replay/measureDownhill.ts <dir>`.
//
// SPD-7 correction (this pass): the original detector had four concrete defects, found
// by comparing against torena-sim's reference implementation of the same measurement
// against real game captures on the same course and downhill band --
// honse-sim-wasm/tests/capture_accuracy.rs, function `observed_downhill_regions`. Fixed
// here: the guts modifier wasn't applied past phase 2 (2/3 course distance), the
// threshold was 0.8 instead of 0.5, expected-drain speed was frame-start instead of
// interval-average, and rushed frames weren't excluded. See the NOTE below the
// paired-comparison output for what this now actually isolates and why the phase split
// exists.
import * as fs from 'fs';
import * as path from 'path';

import { CourseHelpers } from '../../CourseData';
import { parseReplayFile } from './parseReplay';

// hakuraku's reference HP consumption formula (raceConstants.ts / speedCalculations.ts) is
// bit-for-bit the same formula as this engine's own HpPolicy.ts:46,89-92 --
// baseSpeed = 20 - (dist-2000)/1000, consumption = 20*(v-baseSpeed+12)^2/144. Cross-checking
// against our own formula here is itself a useful sanity check, not just borrowed convenience.
function baseSpeed(courseDistance: number) { return 20.0 - (courseDistance - 2000) / 1000.0; }

// SPD-7: guts modifier, ported from HpPolicy.ts:71/105 (`this.gutsModifier = 1.0 + 200.0 /
// Math.sqrt(600.0 * horse.guts)`, applied when `state.phase >= 2`). torena-sim's reference
// applies the equivalent modifier the same way against `baseGuts` from the replay's own
// raceParam -- see capture_accuracy.rs's `observed_downhill_regions`.
function gutsModifier(baseGuts: number) { return 1.0 + 200.0 / Math.sqrt(600.0 * baseGuts); }

function expectedHpConsumption(speed: number, courseDistance: number, pastPhase2: boolean, baseGuts: number) {
	const bs = baseSpeed(courseDistance);
	const base = 20.0 * Math.pow(Math.max(0, speed - bs + 12.0), 2) / 144.0;
	return pastPhase2 ? base * gutsModifier(baseGuts) : base;
}

// SPD-7: 0.5, not hakuraku's 0.8 -- ported from torena-sim's reference detector
// (capture_accuracy.rs's `observed_downhill_regions`), whose own comment is the reasoning:
// PositionKeep's PaceDown modifier is 0.6x and never gets as low as 0.5, so a 0.5 threshold
// isolates the downhill 0.4x factor (HpPolicy.ts@downhill-hp-modifier) cleanly. Note PaceDown
// cannot actually reach this course's 950m band at all -- position keep ends at
// `sectionLength * 3` = 200m (667m in compare mode) on 1600m, RaceSolver.ts:516,530 -- so 0.8's
// real problem here was not PaceDown but the missing guts modifier inflating every ratio past
// 2/3 distance by ~1.3x. The 0.5 threshold is kept anyway: it is the reference's, and it stays
// correct on courses where a downhill band does overlap position keep.
const DOWNHILL_HP_RATIO_THRESHOLD = 0.5;

interface Sample { file: string; horse: number; t: number; dist: number; speed: number; ratio: number; active: boolean; pastPhase2: boolean; }

function stats(xs: number[]) {
	const n = xs.length;
	const mean = xs.reduce((a, b) => a + b, 0) / n;
	const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
	return {n, mean, sd};
}

function pairedDiffStats(samples: Sample[]) {
	const perRunSpeed = new Map<string, {activeSpeeds: number[], inactiveSpeeds: number[]}>();
	for (const s of samples) {
		const k = `${s.file}#${s.horse}`;
		if (!perRunSpeed.has(k)) perRunSpeed.set(k, {activeSpeeds: [], inactiveSpeeds: []});
		const e = perRunSpeed.get(k)!;
		(s.active ? e.activeSpeeds : e.inactiveSpeeds).push(s.speed);
	}
	const pairedDiffs: number[] = [];
	for (const e of perRunSpeed.values()) {
		if (e.activeSpeeds.length === 0 || e.inactiveSpeeds.length === 0) continue;
		const meanActive = e.activeSpeeds.reduce((a, b) => a + b, 0) / e.activeSpeeds.length;
		const meanInactive = e.inactiveSpeeds.reduce((a, b) => a + b, 0) / e.inactiveSpeeds.length;
		pairedDiffs.push(meanActive - meanInactive);
	}
	const s = stats(pairedDiffs);
	const se = s.n > 0 ? s.sd / Math.sqrt(s.n) : NaN;
	return {...s, ciLow: s.mean - 1.96 * se, ciHigh: s.mean + 1.96 * se};
}

function printHistogram(samples: Sample[]) {
	const hist = new Map<number, number>();
	for (const smp of samples) {
		const b = Math.floor(smp.ratio * 10) / 10;
		hist.set(b, (hist.get(b) || 0) + 1);
	}
	for (const [b, c] of [...hist.entries()].sort((a, b) => a[0] - b[0])) {
		if (b > 2.0) continue;
		console.log(`  ${b.toFixed(1)}-${(b + 0.1).toFixed(1)}: ${'#'.repeat(Math.round(c / 10))} (${c})`);
	}
}

function run(dir: string) {
	const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
	const samples: Sample[] = [];
	let courseSetId: number | null = null;

	for (const f of files) {
		const {json, parsed} = parseReplayFile(path.join(dir, f));
		if (courseSetId == null) courseSetId = json.raceCourseSet.id;
		else if (json.raceCourseSet.id !== courseSetId) {
			throw new Error(`mixed courses in ${dir}: ${courseSetId} vs ${json.raceCourseSet.id} (${f}) -- this tool assumes one course per directory, matching PIPE-21's corpus layout`);
		}
		const course = CourseHelpers.getCourse(courseSetId);
		const downhillSlopes = course.slopes.filter(s => s.slope < 0);
		const phase2Start = course.distance * 2 / 3;

		for (let h = 0; h < parsed.horseNum; h++) {
			// SPD-7: baseGuts from the replay's own raceParam (already raw guts x motivation
			// coefficient), matching HpPolicy.ts's `horse.guts` at init() time.
			const baseGuts = json.raceHorse[h].raceParam.baseGuts;

			for (let i = 0; i < parsed.frame.length - 1; i++) {
				const fr = parsed.frame[i], nx = parsed.frame[i + 1];
				const a = fr.horseFrame[h], b = nx.horseFrame[h];
				const dist = a.distance;
				const onDownhill = downhillSlopes.some(s => dist >= s.start && dist < s.start + s.length);
				if (!onDownhill) continue;

				// SPD-7: exclude rushed frames -- Rushed applies its own 1.6x HP modifier
				// (HpPolicy.ts@lead-competition-hp-modifier's `else if (state.isRushed)`
				// branch) which would otherwise masquerade as a low HP-ratio active frame. Require
				// both endpoints unrushed, and a live (non-exhausted) horse at the far endpoint.
				if (a.temptationMode !== 0 || b.temptationMode !== 0) continue;
				if (!(b.hp > 0)) continue;

				const dt = nx.time - fr.time;
				if (dt <= 0 || a.speed <= 0) continue;

				// SPD-7: interval-average speed, not frame-start -- frame cadence is ~1.07s for
				// 97% of the race (parseReplay.ts's header comment), so frame-start speed badly
				// misrepresents the interval's actual expected consumption.
				const intervalSpeed = (a.speed + b.speed) / 2;
				const midpoint = (a.distance + b.distance) / 2;
				const pastPhase2 = midpoint >= phase2Start;

				const rate = (a.hp - b.hp) / dt;
				const expected = expectedHpConsumption(intervalSpeed, course.distance, pastPhase2, baseGuts);
				if (!(expected > 0 && rate > 0)) continue;
				const ratio = rate / expected;
				samples.push({file: f, horse: h, t: fr.time, dist, speed: intervalSpeed, ratio, active: ratio < DOWNHILL_HP_RATIO_THRESHOLD, pastPhase2});
			}
		}
	}

	const active = samples.filter(s => s.active);
	const inactive = samples.filter(s => !s.active);

	console.log(`course ${courseSetId}, ${files.length} files, ${samples.length} downhill-band samples`);
	console.log(`classified active (ratio<${DOWNHILL_HP_RATIO_THRESHOLD}): ${active.length}, inactive: ${inactive.length}`);

	console.log('\n--- HP-ratio cross-check (engine predicts 0.4x during downhill, HpPolicy.ts:67) ---');
	console.log('active-frame ratio stats:', stats(active.map(s => s.ratio)));
	// PIPE-21's separate "deep-active (ratio<0.5)" cut is gone: the classification threshold is
	// itself 0.5 now, so that filter would reproduce `active` exactly. The active-frame stats
	// printed just above are the 0.4x cross-check.

	// SPD-7: split by phase-2 boundary in addition to the whole band. Target speed changes
	// at the phase boundary independent of the downhill bonus, so a paired active-vs-inactive
	// diff over the whole band can be driven by which side of the boundary the active/inactive
	// frames happen to sit on, not by the downhill bonus itself. Reporting the two sides
	// separately (plus the pre-existing whole-band number) lets that be checked directly.
	console.log('\n--- paired within-horse-run speed comparison (controls for build/phase confounds) ---');
	const wholeBand = pairedDiffStats(samples);
	console.log(`[whole band]      paired horse-runs: ${wholeBand.n}, mean diff (active - inactive): ${wholeBand.mean.toFixed(4)} m/s, sd=${wholeBand.sd.toFixed(4)}`);
	console.log(`                  95% CI: [${wholeBand.ciLow.toFixed(4)}, ${wholeBand.ciHigh.toFixed(4)}] m/s`);

	const beforePhase2 = pairedDiffStats(samples.filter(s => !s.pastPhase2));
	console.log(`[before 2/3 dist] paired horse-runs: ${beforePhase2.n}, mean diff (active - inactive): ${beforePhase2.n > 0 ? beforePhase2.mean.toFixed(4) : 'n/a'} m/s, sd=${beforePhase2.n > 0 ? beforePhase2.sd.toFixed(4) : 'n/a'}`);
	if (beforePhase2.n > 0) console.log(`                  95% CI: [${beforePhase2.ciLow.toFixed(4)}, ${beforePhase2.ciHigh.toFixed(4)}] m/s`);

	const atOrAfterPhase2 = pairedDiffStats(samples.filter(s => s.pastPhase2));
	console.log(`[at/after 2/3 dist] paired horse-runs: ${atOrAfterPhase2.n}, mean diff (active - inactive): ${atOrAfterPhase2.n > 0 ? atOrAfterPhase2.mean.toFixed(4) : 'n/a'} m/s, sd=${atOrAfterPhase2.n > 0 ? atOrAfterPhase2.sd.toFixed(4) : 'n/a'}`);
	if (atOrAfterPhase2.n > 0) console.log(`                  95% CI: [${atOrAfterPhase2.ciLow.toFixed(4)}, ${atOrAfterPhase2.ciHigh.toFixed(4)}] m/s`);

	console.log('NOTE: candidate speed bonuses under test are +0.2 m/s (engine+doc) vs +0.4 m/s (hakuraku) at a 1% grade.');
	console.log('The detector above now isolates the 0.4x downhill HP-consumption factor specifically (threshold 0.5,');
	console.log('guts modifier applied past 2/3 course distance, interval-average speed, rushed frames excluded --');
	console.log('see SPD-7 and the corrections cited at this file\'s top). The phase split exists because target speed');
	console.log('changes at the 2/3-distance boundary independent of the downhill bonus: a whole-band paired diff can');
	console.log('be skewed by active/inactive frames sitting on opposite sides of that boundary rather than by the');
	console.log('downhill speed bonus itself. Compare the three numbers above before drawing a conclusion.');

	console.log('\n--- full ratio histogram (all downhill-band samples, bin=0.1) ---');
	printHistogram(samples);

	console.log('\n--- ratio histogram, before 2/3 course distance ---');
	printHistogram(samples.filter(s => !s.pastPhase2));

	console.log('\n--- ratio histogram, at/after 2/3 course distance ---');
	printHistogram(samples.filter(s => s.pastPhase2));
}

if (require.main === module) {
	const dir = process.argv[2];
	if (!dir) { console.error('usage: tsx measureDownhill.ts <dir of replay JSONs, all the same course>'); process.exit(1); }
	run(dir);
}

export { run };
