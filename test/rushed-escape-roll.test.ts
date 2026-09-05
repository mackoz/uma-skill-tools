// DYN-11: the Rushed 3-second escape roll used to detect its boundary with a hardcoded 0.017s
// (1/60s) epsilon while every real caller steps at 1/15s, which silently dropped the 6s and 9s
// rolls -- Rushed umas escaped 55% of the time instead of ~90.9%. This pins the fixed behavior:
// exactly 3 escape rolls at 3s/6s/9s (55% each), a forced end at 12s, and no dependence on the
// timestep used to reach those boundaries. Confirmed against two independent reference engines:
// mee1080/umasim RaceCalculator.kt:245-263 and alpha123/uma-skill-tools RaceSolver.ts:348-359.
import { test } from 'vitest';
import { ok, strictEqual } from 'node:assert/strict';
import { RaceSolver, Timer } from '../RaceSolver';
import { Rule30CARng } from '../Random';
import { attachMethods, stepUntilInactive, seededSubStream } from './RaceSolverTestHelpers';

// updateRushedState()/endRushedState() only touch a handful of instance fields (see RaceSolver.ts);
// build the minimal stand-in rather than constructing a full RaceSolver (course/horse/skills), which
// keeps this test independent of the data-driven builder machinery test/race.ts already covers.
function makeRushedStub(seed: number) {
	return attachMethods({
		isRushed: false,
		hasBeenRushed: false,
		rushedSection: 2,
		rushedEnterPosition: 0,
		pos: 0,
		rushedTimer: new Timer(0),
		rushedEscapeRolls: 0,
		rushedMaxDuration: 12.0,
		rushedActivations: [] as Array<[number, number]>,
		rushedRng: new Rule30CARng(seed),
	}, 'endRushedState');
}

// Run one race's worth of Rushed, stepping updateRushedState() the way RaceSolver.step() does:
// increment the timer by dt first, then evaluate. Returns the duration (s) Rushed lasted.
function simulateOneRushedDuration(seed: number, dt: number): number {
	const s = makeRushedStub(seed);
	RaceSolver.prototype.updateRushedState.call(s); // entry, since pos(0) >= rushedEnterPosition(0)
	return stepUntilInactive(s, RaceSolver.prototype.updateRushedState, s => s.rushedTimer, s => s.isRushed, dt, 20);
}

function histogram(dt: number, samples: number, masterSeed: number) {
	const nextSeed = seededSubStream(masterSeed);
	const counts = {3: 0, 6: 0, 9: 0, 12: 0};
	for (let i = 0; i < samples; ++i) {
		const duration = simulateOneRushedDuration(nextSeed(), dt);
		// bucket into the nearest of the 4 possible exit points, tolerant of float-drift overshoot
		// past a boundary (up to ~1 frame -- see DYN-11's plan for why that drift is expected and
		// harmless) with margin to spare before the next boundary 3s away.
		const bucket = [3, 6, 9, 12].find(b => duration <= b + 1.5 * dt) ?? 12;
		counts[bucket]++;
	}
	return counts;
}

test('Rushed escapes at exactly 3 boundaries (3s/6s/9s) plus a forced 12s cap', () => {
	const s = makeRushedStub(1);
	RaceSolver.prototype.updateRushedState.call(s);
	ok(s.isRushed, 'enters rushed state once pos reaches rushedEnterPosition');

	// Force every escape roll to fail so we walk the full 12s without early exit,
	// and confirm rushedEscapeRolls never exceeds 3 regardless of how long we keep stepping.
	s.rushedRng = {random: () => 1.0} as any; // always >= 0.55, never escapes early
	const dt = 1 / 15;
	const t_ = stepUntilInactive(s, RaceSolver.prototype.updateRushedState, s => s.rushedTimer, s => s.isRushed, dt, 20);

	strictEqual(s.rushedEscapeRolls, 3, 'exactly 3 escape rolls are taken, never more');
	ok(!s.isRushed, 'still force-ends at the 12s cap even when every escape roll fails');
	ok(t_ >= 12 && t_ < 12 + dt, 'forced end lands within one frame of the 12s cap');
});

test('Rushed escape distribution matches the reference (55%/24.75%/11.14%/9.11% at 3/6/9/12s)', () => {
	const dt = 1 / 15;
	const samples = 20000;
	const counts = histogram(dt, samples, 424242);
	const pct = (n: number) => (100 * counts[n]) / samples;

	// P(escape at 3s) = 0.55; P(6s) = 0.45*0.55; P(9s) = 0.45^2*0.55; P(12s, forced) = 0.45^3
	ok(Math.abs(pct(3) - 55) < 2, `escape-at-3s ~55% (got ${pct(3).toFixed(2)}%)`);
	ok(Math.abs(pct(6) - 24.75) < 2, `escape-at-6s ~24.75% (got ${pct(6).toFixed(2)}%)`);
	ok(Math.abs(pct(9) - 11.14) < 2, `escape-at-9s ~11.14% (got ${pct(9).toFixed(2)}%)`);
	ok(Math.abs(pct(12) - 9.11) < 2, `forced-end-at-12s ~9.11% (got ${pct(12).toFixed(2)}%)`);
});

test('Rushed escape distribution is independent of the integration timestep', () => {
	const samples = 8000;
	const at15 = histogram(1 / 15, samples, 111111);
	const at60 = histogram(1 / 60, samples, 111111);
	for (const bucket of [3, 6, 9, 12] as const) {
		const p15 = (100 * at15[bucket]) / samples;
		const p60 = (100 * at60[bucket]) / samples;
		ok(Math.abs(p15 - p60) < 3, `bucket ${bucket}s: 1/15s=${p15.toFixed(2)}% vs 1/60s=${p60.toFixed(2)}% agree`);
	}
});
