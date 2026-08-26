// DYN-8: spot-struggle duration dropped the StrategyProficiencyModifier factor, so a G-aptitude
// Front Runner struggled for the same ~11s as an A-aptitude one instead of ~1.1s. This pins the
// fixed formula against hakuraku.moe/notes/spot-struggle's replay-frame measurements (the game's
// own CompeteTop parameter block gives the S..G table: 1.1/1.0/0.85/0.75/0.6/0.4/0.2/0.1).
import test from 'tape';
import { RaceSolver, Timer } from '../RaceSolver';
import { Aptitude } from '../HorseTypes';
import { attachMethods, stepUntilInactive } from './RaceSolverTestHelpers';

// updateLeadCompetition() dispatches straight to updateLeadCompetitionExit() when
// leadCompetitionStart is non-null, so the entry-detection half (tryStartLeadCompetition(),
// this.sectionLength) is unreachable here -- same spirit as test/rushed-escape-roll.ts's stub.
// updateLeadCompetitionExit is attached because updateLeadCompetition() calls it as
// this.updateLeadCompetitionExit(), which a plain stub doesn't have on its prototype chain
// otherwise. umas is deliberately empty: that method's DYN-14 distance/lateral exit reads
// `this.umas` for other same-style participants, and an empty list makes that branch a no-op
// (zero participants -> immediate return), so the duration timer alone still governs exit here,
// exactly as before DYN-14.
function makeStruggleStub(guts: number, strategyAptitude: Aptitude) {
	return attachMethods({
		leadCompetitionEnabled: true,
		leadCompetition: true,
		leadCompetitionStart: 0,
		leadCompetitionEnd: Infinity, // exit governed by the timer alone, not by position
		leadCompetitionTimer: new Timer(0),
		pos: 0,
		horse: {guts, strategyAptitude},
		umas: [] as any[],
	}, 'updateLeadCompetitionExit');
}

// Step the way RaceSolver.step() does: advance the timer by dt, then evaluate. Returns the elapsed
// time at which the struggle ended (always in [duration, duration + dt)).
function spotStruggleDuration(guts: number, aptitude: Aptitude, dt = 1 / 15): number {
	const s = makeStruggleStub(guts, aptitude);
	return stepUntilInactive(s, RaceSolver.prototype.updateLeadCompetition, s => s.leadCompetitionTimer, s => s.leadCompetition, dt, 60);
}

const unmodified = (guts: number) => Math.pow(700 * guts, 0.5) * 0.012;
const dt = 1 / 15;

test('A-rank aptitude (1.0x) leaves the base duration unchanged', t => {
	// Regression guard on the refactor itself: A is the identity rank, so every A-aptitude
	// result must be bit-for-bit what the engine produced before DYN-8.
	const d = spotStruggleDuration(700, Aptitude.A);
	t.ok(Math.abs(d - 8.4) < dt, `700 guts, A: ~8.4s (got ${d.toFixed(3)}s)`); // (700*700)^0.5*0.012
	t.end();
});

test('G-rank aptitude (0.1x) matches hakuraku Special Week (<1.8s, not ~11s)', t => {
	const guts = 1200; // unmodified prediction ~= 11.0s, matching the note's stated baseline
	const d = spotStruggleDuration(guts, Aptitude.G);
	t.ok(Math.abs(d - 0.1 * unmodified(guts)) < dt, `1200 guts, G: ~1.10s (got ${d.toFixed(3)}s)`);
	t.ok(d < 1.8, 'under the <1.8s observed replay bound, which the unmodified ~11s formula blows past');
	t.end();
});

test('D-rank aptitude (0.6x) matches hakuraku Super Creek (<7.13s)', t => {
	const guts = 1200;
	const d = spotStruggleDuration(guts, Aptitude.D);
	t.ok(Math.abs(d - 0.6 * unmodified(guts)) < dt, `1200 guts, D: ~6.60s (got ${d.toFixed(3)}s)`);
	t.ok(d < 7.13, 'under the <7.13s observed replay bound');
	t.end();
});

test('S-rank aptitude (1.1x) matches hakuraku Bourbon (>= 1.06864x unmodified at 518 guts)', t => {
	const guts = 518; // Bourbon's measured guts; unmodified = 7.226s, S-scaled = 7.949s
	const d = spotStruggleDuration(guts, Aptitude.S);
	t.ok(Math.abs(d - 1.1 * unmodified(guts)) < dt, `518 guts, S: ~7.95s (got ${d.toFixed(3)}s)`);
	t.ok(d >= 1.06864 * unmodified(guts), 'clears the frame the replay proves she was still struggling on');
	t.end();
});
