// PIPE-21 step 1 (measurement pass): cross-check the engine's downhill accel-mode HP
// and speed effects against real replay data, using hakuraku's own HP-drain-based
// detector so the detection doesn't depend on the speed effect being measured. No
// simulator run -- pure corpus measurement over a directory of decoded replays.
//
// Settles (partially) SPD-7 -- see that ticket for the two competing formulas this
// was built to distinguish. Run: `npx ts-node tools/replay/measureDownhill.ts <dir>`.
import * as fs from 'fs';
import * as path from 'path';

import { CourseHelpers } from '../../CourseData';
import { parseReplayFile } from './parseReplay';

// hakuraku's reference HP consumption formula (raceConstants.ts / speedCalculations.ts) is
// bit-for-bit the same formula as this engine's own HpPolicy.ts:46,89-92 --
// baseSpeed = 20 - (dist-2000)/1000, consumption = 20*(v-baseSpeed+12)^2/144. Cross-checking
// against our own formula here is itself a useful sanity check, not just borrowed convenience.
function baseSpeed(courseDistance: number) { return 20.0 - (courseDistance - 2000) / 1000.0; }
function expectedHpConsumption(speed: number, courseDistance: number) {
	const bs = baseSpeed(courseDistance);
	return 20.0 * Math.pow(Math.max(0, speed - bs + 12.0), 2) / 144.0;
}
const DOWNHILL_HP_RATIO_THRESHOLD = 0.8; // hakuraku's detector threshold -- a Tier-3 inference heuristic, not a game constant; see plans/hakuraku/README.md's confidence tiers

interface Sample { file: string; horse: number; t: number; dist: number; speed: number; ratio: number; active: boolean; }

function stats(xs: number[]) {
	const n = xs.length;
	const mean = xs.reduce((a, b) => a + b, 0) / n;
	const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
	return {n, mean, sd};
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

		for (let h = 0; h < parsed.horseNum; h++) {
			for (let i = 0; i < parsed.frame.length - 1; i++) {
				const fr = parsed.frame[i], nx = parsed.frame[i + 1];
				const a = fr.horseFrame[h], b = nx.horseFrame[h];
				const dist = a.distance;
				const onDownhill = downhillSlopes.some(s => dist >= s.start && dist < s.start + s.length);
				if (!onDownhill) continue;
				const dt = nx.time - fr.time;
				if (dt <= 0 || a.speed <= 0) continue;
				const rate = (a.hp - b.hp) / dt;
				const expected = expectedHpConsumption(a.speed, course.distance);
				if (!(expected > 0 && rate > 0)) continue;
				const ratio = rate / expected;
				samples.push({file: f, horse: h, t: fr.time, dist, speed: a.speed, ratio, active: ratio < DOWNHILL_HP_RATIO_THRESHOLD});
			}
		}
	}

	const active = samples.filter(s => s.active);
	const inactive = samples.filter(s => !s.active);

	console.log(`course ${courseSetId}, ${files.length} files, ${samples.length} downhill-band samples`);
	console.log(`classified active (ratio<${DOWNHILL_HP_RATIO_THRESHOLD}): ${active.length}, inactive: ${inactive.length}`);

	console.log('\n--- HP-ratio cross-check (engine predicts 0.4x during downhill, HpPolicy.ts:67) ---');
	console.log('active-frame ratio stats:', stats(active.map(s => s.ratio)));
	const deep = samples.filter(s => s.ratio < 0.5); // less likely contaminated by non-downhill low-HP-consumption states (e.g. PaceDown, 0.6x) crossing the 0.8 threshold by chance
	console.log(`deep-active (ratio<0.5, less likely contaminated by other low-consumption states like PaceDown's 0.6x): n=${deep.length}, mean=${(deep.reduce((a, b) => a + b.ratio, 0) / deep.length).toFixed(4)}`);

	console.log('\n--- paired within-horse-run speed comparison (controls for build/phase confounds) ---');
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
	const se = s.sd / Math.sqrt(s.n);
	console.log(`paired horse-runs: ${s.n}, mean diff (active - inactive): ${s.mean.toFixed(4)} m/s, sd=${s.sd.toFixed(4)}`);
	console.log(`95% CI: [${(s.mean - 1.96 * se).toFixed(4)}, ${(s.mean + 1.96 * se).toFixed(4)}] m/s`);
	console.log('NOTE: candidate speed bonuses under test are +0.2 m/s (engine+doc) vs +0.4 m/s (hakuraku) at a 1% grade.');
	console.log('This paired comparison is confounded by the HP-ratio detector also catching other low-consumption');
	console.log('states (e.g. PaceDown, 0.6x) that independently correlate with lower speed by construction -- a');
	console.log('negative or near-zero result here does NOT confirm the engine\'s speed-bonus sign is wrong; see');
	console.log('PIPE-21\'s findings writeup for the full reasoning before drawing a conclusion from this alone.');

	console.log('\n--- full ratio histogram (all downhill-band samples, bin=0.1) ---');
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

if (require.main === module) {
	const dir = process.argv[2];
	if (!dir) { console.error('usage: ts-node measureDownhill.ts <dir of replay JSONs, all the same course>'); process.exit(1); }
	run(dir);
}

export { run };
