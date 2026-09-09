// SKL-7: the deterministic half of ability_value_usage / ability_time_usage scaling. Every
// bracket boundary below is quoted from game-mechanics/skills.md's Value Scaling and Duration
// Scaling tables. The identity assertions matter as much as the arithmetic: an unimplemented
// code must return exactly 1.0 rather than throw or guess, because ~45 shipped skills carry
// codes this engine deliberately does not model.
import { test } from 'vitest';
import { strictEqual, ok } from 'node:assert/strict';
import { valueScaleFactor, durationScaleFactor, ScalingContext } from '../ValueScaling';
import { RaceSolver, Perspective, SkillType, PendingSkill, SkillEffect } from '../RaceSolver';
import { attachMethods } from './RaceSolverTestHelpers';

function ctx(over: Partial<ScalingContext> = {}): ScalingContext {
	return {skillCount: 0, maxBaseStat: 0, finalSpeed: 0, remainingHp: 0, ...over};
}

// 1 + 0.01*n is not exact in binary floating point, so compare with a tolerance rather than
// strictEqual for the usage-2 formula.
function close(actual: number, expected: number) {
	ok(Math.abs(actual - expected) < 1e-9, `expected ~${expected}, got ${actual}`);
}

test('usage 2 MultiplySkillNum: 1 + 0.01*n, capped at 1.2', () => {
	close(valueScaleFactor(2, ctx({skillCount: 0})), 1.0);
	close(valueScaleFactor(2, ctx({skillCount: 5})), 1.05);
	close(valueScaleFactor(2, ctx({skillCount: 20})), 1.2);
	close(valueScaleFactor(2, ctx({skillCount: 100})), 1.2);
});

test('usage 13 MultiplyMaximumRawStatus brackets', () => {
	strictEqual(valueScaleFactor(13, ctx({maxBaseStat: 599})), 0.8);
	strictEqual(valueScaleFactor(13, ctx({maxBaseStat: 600})), 0.9);
	strictEqual(valueScaleFactor(13, ctx({maxBaseStat: 799})), 0.9);
	strictEqual(valueScaleFactor(13, ctx({maxBaseStat: 800})), 1.0);
	strictEqual(valueScaleFactor(13, ctx({maxBaseStat: 1000})), 1.1);
	strictEqual(valueScaleFactor(13, ctx({maxBaseStat: 1100})), 1.2);
	strictEqual(valueScaleFactor(13, ctx({maxBaseStat: 9999})), 1.2);
});

test('usage 22 MultiplySpeed type 1 floors at 0.0 below 1700', () => {
	strictEqual(valueScaleFactor(22, ctx({finalSpeed: 1699})), 0.0);
	strictEqual(valueScaleFactor(22, ctx({finalSpeed: 1700})), 1.0);
	strictEqual(valueScaleFactor(22, ctx({finalSpeed: 1800})), 2.0);
	strictEqual(valueScaleFactor(22, ctx({finalSpeed: 1900})), 3.0);
	strictEqual(valueScaleFactor(22, ctx({finalSpeed: 2000})), 4.0);
});

test('usage 23 MultiplySpeed type 2 brackets', () => {
	strictEqual(valueScaleFactor(23, ctx({finalSpeed: 1399})), 1.0);
	strictEqual(valueScaleFactor(23, ctx({finalSpeed: 1400})), 2.0);
	strictEqual(valueScaleFactor(23, ctx({finalSpeed: 1600})), 3.0);
});

test('time usage 3 MultiplyRemainHp type 1 brackets', () => {
	strictEqual(durationScaleFactor(3, ctx({remainingHp: 1999})), 1.0);
	strictEqual(durationScaleFactor(3, ctx({remainingHp: 2000})), 1.5);
	strictEqual(durationScaleFactor(3, ctx({remainingHp: 2400})), 2.0);
	strictEqual(durationScaleFactor(3, ctx({remainingHp: 2600})), 2.2);
	strictEqual(durationScaleFactor(3, ctx({remainingHp: 2800})), 2.5);
	strictEqual(durationScaleFactor(3, ctx({remainingHp: 3000})), 3.0);
	strictEqual(durationScaleFactor(3, ctx({remainingHp: 3200})), 3.5);
	strictEqual(durationScaleFactor(3, ctx({remainingHp: 3500})), 4.0);
});

test('time usage 7 MultiplyRemainHp type 2 brackets', () => {
	strictEqual(durationScaleFactor(7, ctx({remainingHp: 1499})), 1.0);
	strictEqual(durationScaleFactor(7, ctx({remainingHp: 1500})), 1.5);
	strictEqual(durationScaleFactor(7, ctx({remainingHp: 1800})), 2.0);
	strictEqual(durationScaleFactor(7, ctx({remainingHp: 2000})), 2.5);
	strictEqual(durationScaleFactor(7, ctx({remainingHp: 2100})), 3.0);
});

test('every unimplemented or absent code is exactly identity', () => {
	const c = ctx({skillCount: 30, maxBaseStat: 1200, finalSpeed: 2000, remainingHp: 3600});
	// 1 = Direct; 8/9 = Multiply Random, handled by RaceSolver's own RNG path, so this
	// function must NOT also scale them; 3-7/10/12/24 = scenario or account state; 14/19/20/
	// 21/25 = state this engine samples rather than models; 11/26-40 = undocumented.
	for (const u of [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 19, 20, 21, 24, 25, 26, 27, 28,
	                 30, 31, 32, 34, 35, 36, 37, 40, undefined]) {
		strictEqual(valueScaleFactor(u, c), 1.0, `valueScaleFactor(${u})`);
	}
	for (const u of [1, 2, 4, 5, 6, 8, undefined]) {
		strictEqual(durationScaleFactor(u, c), 1.0, `durationScaleFactor(${u})`);
	}
});

// scaleEffectValue() reads only skillValueSeed, skillActivationCounts and the fields
// scalingContext() touches, so the stub carries exactly those -- same minimal-stub spirit as
// test/value-scaling-roll.test.ts.
function makeScalingStub(over: Partial<ScalingContext> = {}) {
	return attachMethods({
		skillValueSeed: 1,
		skillActivationCounts: new Map<string, number>(),
		equippedSkillCount: over.skillCount ?? 0,
		maxBaseStat: over.maxBaseStat ?? 0,
		horse: {speed: over.finalSpeed ?? 0},
		hp: {hpRemaining: () => over.remainingHp ?? 0}
	}, 'scaleEffectValue', 'scalingContext');
}

test('scaleEffectValue applies a deterministic factor and returns ef0 itself at identity', () => {
	const stub = makeScalingStub({maxBaseStat: 500});  // usage 13 -> 0.8x
	const ef: SkillEffect = {type: SkillType.TargetSpeed, baseDuration: 0, modifier: 100, valueUsage: 13};
	const scaled = stub.scaleEffectValue({skillId: 'x', perspective: Perspective.Self} as PendingSkill, ef, 0);
	close(scaled.modifier, 80);

	// Identity must return the *same object*, not a copy -- HP-6's contract, relied on by the
	// dispatch site in activateSkill().
	const direct: SkillEffect = {type: SkillType.TargetSpeed, baseDuration: 0, modifier: 100, valueUsage: 1};
	strictEqual(stub.scaleEffectValue({skillId: 'x'} as PendingSkill, direct, 0), direct);
});
