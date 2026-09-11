// SKL-21: spares exist to let a cooldown skill re-arm onto a later candidate point, but that only
// means something for a sample policy that actually places more than one such point. Per the
// game's own mechanics docs:
//   - plans/condition-reference/conditions.md:125 (all_corner_random / AllCornerRandomPolicy):
//     "randomly picks four points ... if the skill in question has a short cooldown, there are
//     multiple points where it can activate this way" -- SPARES=3 (+1 primary = 4) matches exactly.
//   - plans/condition-reference/conditions.md:1493 (straight_random / StraightRandomPolicy):
//     "first rolls for a straight segment, and then for a random point on that segment" -- one
//     point, full stop, no matter how many straights the course has.
// This pins RaceSolverBuilder's consequence of that split using two real skills that both carry a
// cooldown: 200341 (all_corner_random) must receive 3 spares; 200372 (straight_random) must
// receive 0 and therefore can never re-arm.
import { test } from 'vitest';
import { strictEqual } from 'node:assert/strict';
import { RaceSolverBuilder } from '../RaceSolverBuilder';
import { RaceSolver } from '../RaceSolver';

function sparesCountFor(skillId: string): number {
	const builder = new RaceSolverBuilder(1).course(10101).horse({
		speed: 1000,
		stamina: 1000,
		power: 1000,
		guts: 1000,
		wisdom: 1000,
		strategy: 'Oonige',
		distanceAptitude: 'A',
		surfaceAptitude: 'A',
		strategyAptitude: 'A',
		mood: 2
	}).addSkill(skillId);
	const g = builder.build();
	const solver = g.next().value as RaceSolver;
	const pending = solver.pendingSkills.find(s => s.skillId === skillId);
	if (pending == null) throw new Error(`skill ${skillId} never became a pending skill on this course/horse`);
	return pending.spares?.length ?? 0;
}

test('a cooldown skill on AllCornerRandomPolicy (all_corner_random) receives 3 spares', () => {
	strictEqual(sparesCountFor('200341'), 3);
});

test('a cooldown skill on StraightRandomPolicy (straight_random) receives 0 spares', () => {
	strictEqual(sparesCountFor('200372'), 0);
});
