// SPD-7: the downhill accel-mode bonus used signed slope (`0.3 + slopePer/100000`), and since
// slopePer is negative on a downhill that made the bonus SHRINK as the grade got steeper --
// 0.2/0.1/0.0 m/s at 1%/2%/3%, going negative beyond 3%, for a mechanic named "downhill accel
// mode". The correct formula takes the absolute value, so the bonus grows with steepness.
//
// Ground truth: hakuraku's /racedata resimulation, backed by a reverse-engineered reimplementation
// of the game's server-side race simulator whose output matches the real server race. Its
// `detailedSimulation.annotations` exposes exact downhill-mode spans plus a per-sample
// `targetSpeeds` series, so the bonus is directly observable as a step at each span boundary. On
// course 10808 (Kyoto turf 2200m, whose only downhill is slope -20000 = a 2% grade), 26
// unconfounded boundaries across three independent seeds all stepped by exactly 0.500 -- never
// the signed form's 0.100. See docs/adr/0016-downhill-bonus-absolute-slope.md.
//
// The regression checkpoint cannot guard this: it pins whatever the engine currently outputs, so
// re-recording it after a sign regression would simply bless the wrong value. This test pins the
// intended formula instead.
import { test } from 'vitest';
import { strictEqual } from 'node:assert/strict';
import { RaceSolver } from '../RaceSolver';

// updateTargetSpeed()'s downhill branch reads only targetSpeed, isDownhillMode and slopePer.
// The branches above it are bypassed by giving the stub remaining HP and a non-last-spurt state
// with a zeroed base, so `targetSpeed` after the call IS the bonus on its own.
function downhillBonus(rawSlope: number): number {
	const stub = {
		hp: {hasRemainingHp: () => true},
		isLastSpurt: false,
		baseTargetSpeed: [0, 0, 0],
		phase: 1,
		posKeepSpeedCoef: 1,
		sectionModifier: new Array(25).fill(0),
		pos: 0,
		sectionLength: 100,
		modifiers: {targetSpeed: {acc: 0, err: 0}},
		isDownhillMode: true,
		slopePer: rawSlope,
		hillIdx: 0,
		competeFight: false,
		targetSpeed: 0,
	};
	RaceSolver.prototype.updateTargetSpeed.call(stub as any);
	return stub.targetSpeed;
}

// course_data.json stores the grade scaled by 10000, negative downhill: -10000 is a 1% grade.
const grade = (percent: number) => -10000 * percent;

test('bonus grows with steepness instead of shrinking', () => {
	// The whole point of the fix: steeper downhill => bigger boost, monotonically.
	const oneP = downhillBonus(grade(1));
	const twoP = downhillBonus(grade(2));
	const threeP = downhillBonus(grade(3));
	strictEqual(oneP < twoP && twoP < threeP, true,
		`expected monotonic growth, got ${oneP} / ${twoP} / ${threeP}`);
});

test('2% grade gives exactly 0.5 m/s, as measured from server-matching simulation', () => {
	// The directly measured value: 26 unconfounded target-speed steps on course 10808, three
	// seeds, all exactly 0.500. The pre-fix signed formula produced 0.1 here.
	strictEqual(downhillBonus(-20000), 0.5);
});

test('1% and 3% grades follow the same formula', () => {
	strictEqual(downhillBonus(grade(1)), 0.4);
	strictEqual(downhillBonus(grade(3)), 0.6);
});

test('bonus never goes negative on a steep grade', () => {
	// The signed formula zeroed out at 3% and went negative past it -- a "downhill accel" that
	// actively slowed the uma down. Nothing in course_data.json is steeper than 3% today, so this
	// guards a formula property rather than a live course.
	strictEqual(downhillBonus(grade(5)) > 0, true);
});

test('uphill is untouched by this branch', () => {
	// slopePer > 0 must fall through to the uphill penalty, not the downhill bonus. Guards against
	// a "fix" that drops the sign check along with the sign.
	const stub = {
		hp: {hasRemainingHp: () => true},
		isLastSpurt: false,
		baseTargetSpeed: [0, 0, 0],
		phase: 1,
		posKeepSpeedCoef: 1,
		sectionModifier: new Array(25).fill(0),
		pos: 0,
		sectionLength: 100,
		modifiers: {targetSpeed: {acc: 0, err: 0}},
		isDownhillMode: false,
		slopePer: 20000,
		hillIdx: 0,
		horse: {power: 1000},
		minSpeed: -Infinity,
		competeFight: false,
		targetSpeed: 0,
	};
	RaceSolver.prototype.updateTargetSpeed.call(stub as any);
	// -(20000/10000) * 200 / 1000 = -0.4
	strictEqual(stub.targetSpeed, -0.4);
});
