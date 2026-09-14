// SKL-21 review (Minor 2, upgraded to must-fix): the branch's central correction -- cooldown
// scales with course distance (plans/game-mechanics/skills.md's "Skill Cooldown" section:
// Cooldown = BaseCooldown * CourseDistance[m] / 1000) -- had no test that could fail if the
// scaling were dropped. The reviewer mutated RaceSolver.ts's scaledCooldown line to a flat
// `s.cooldown` and all 17 existing cooldown tests stayed green; only test/regression/check.ts
// noticed, as opaque checkpoint divergence with no indication of which line broke. This test
// exercises the real arming code path in processSkillActivations() directly (not a synthetic
// computation re-deriving the formula) on two courses of different length, and asserts the armed
// cooldownTimer value differs between them in exactly the way distance-scaling predicts -- so a
// regression here fails loudly, at the one line that encodes the whole correction, not three
// files away as an unexplained checkpoint number.
import { test } from 'vitest';
import { strictEqual } from 'node:assert/strict';
import { RaceSolver, PendingSkill } from '../RaceSolver';
import { Region } from '../Region';
import { attachMethods } from './RaceSolverTestHelpers';

function makeStub(distance: number, pending: PendingSkill) {
	return attachMethods({
		pos: 1005,
		course: {distance},
		pendingSkills: [pending],
		pendingRemoval: new Set<PendingSkill>(),
		activeTargetSpeedSkills: [],
		activeCurrentSpeedSkills: [],
		activeAccelSkills: [],
		activeLaneMovementSkills: [],
		activeChangeLaneSkills: [],
		activateCountThisFrame: 0,
		activateCountLastFrame: 0,
		timers: [],
		shouldSkipWisdomCheck: (_: PendingSkill) => true,
		checkWisdomForSkill: (_: PendingSkill) => true,
		// This test only cares about the cooldown timer processSkillActivations() arms on
		// activation, not the skill's actual game effects -- a no-op stub keeps the test from
		// needing the rest of RaceSolver's stat/modifier machinery.
		activateSkill: (_: PendingSkill) => {}
	}, 'processSkillActivations', 'pendingSkillAction', 'rearmSkill', 'getNewTimer');
}

function cooldownSkill(baseCooldown: number): PendingSkill {
	return {
		skillId: '200331',
		rarity: 2,
		trigger: new Region(1000, 1010),
		extraCondition: () => true,
		effects: [],
		cooldown: baseCooldown
	} as PendingSkill;
}

test('the cooldown timer arms at BaseCooldown * courseDistance/1000, not a flat BaseCooldown', () => {
	const shortCourseSkill = cooldownSkill(30);
	makeStub(1200, shortCourseSkill).processSkillActivations();
	strictEqual(shortCourseSkill.cooldownTimer!.t, -(30 * 1200 / 1000), 'armed value on a 1200m course');

	const longCourseSkill = cooldownSkill(30);
	makeStub(3600, longCourseSkill).processSkillActivations();
	strictEqual(longCourseSkill.cooldownTimer!.t, -(30 * 3600 / 1000), 'armed value on a 3600m course');

	// The actual point: the two armed values must differ, proportionally to course distance, not
	// come out identical (which is what a flat, unscaled BaseCooldown would produce).
	strictEqual(longCourseSkill.cooldownTimer!.t / shortCourseSkill.cooldownTimer!.t, 3600 / 1200,
		'the ratio between the two armed values must match the ratio between the two course distances');
});
