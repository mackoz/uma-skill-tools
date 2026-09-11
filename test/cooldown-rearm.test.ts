// SKL-21: skills with a real in-game cooldown re-activate when their condition is satisfied again
// after the cooldown expires. The decision is factored out of processSkillActivations()'s loop into
// pendingSkillAction() so it can be driven from a minimal stub, matching the stubbing style of
// value-scaling-roll.test.ts and rushed-escape-roll.test.ts.
import { test } from 'vitest';
import { strictEqual, ok } from 'node:assert/strict';
import { RaceSolver, PendingAction, PendingSkill, Timer } from '../RaceSolver';
import { Region } from '../Region';
import { attachMethods } from './RaceSolverTestHelpers';

function makeStub(pos: number, wisdom: {shouldSkipWisdomCheck?: (s: PendingSkill) => boolean, checkWisdomForSkill?: (s: PendingSkill) => boolean} = {}) {
	return attachMethods({
		pos,
		pendingRemoval: new Set<string>(),
		shouldSkipWisdomCheck: wisdom.shouldSkipWisdomCheck ?? ((_: PendingSkill) => true),
		checkWisdomForSkill: wisdom.checkWisdomForSkill ?? ((_: PendingSkill) => true)
	}, 'pendingSkillAction', 'rearmSkill');
}

function skill(overrides: Partial<PendingSkill> = {}): PendingSkill {
	return {
		skillId: '200331',
		rarity: 2,
		trigger: new Region(1000, 1010),
		extraCondition: () => true,
		effects: [],
		...overrides
	} as PendingSkill;
}

test('a skill with no cooldown is removed once its window passes', () => {
	strictEqual(makeStub(1200).pendingSkillAction(skill()), PendingAction.Remove);
});

test('a skill with no cooldown activates inside its window', () => {
	strictEqual(makeStub(1005).pendingSkillAction(skill()), PendingAction.Activate);
});

test('a cooldown skill that has not fired yet is removed on a missed window, not re-armed', () => {
	const s = skill({cooldown: 30, spares: [new Region(1500, 1510)]});
	strictEqual(makeStub(1200).pendingSkillAction(s), PendingAction.Remove,
		'spares are only consulted after a successful activation');
});

test('a re-armed candidate reached while cooling down is skipped, not fired', () => {
	const s = skill({
		trigger: new Region(1500, 1510),
		cooldown: 30,
		spares: [new Region(1800, 1810)],
		cooldownTimer: new Timer(-12)   // 12s still to run
	});
	strictEqual(makeStub(1505).pendingSkillAction(s), PendingAction.Rearm);
});

test('a re-armed candidate reached after the cooldown expires fires', () => {
	const s = skill({
		trigger: new Region(1800, 1810),
		cooldown: 30,
		spares: [],
		cooldownTimer: new Timer(0.5)   // expired
	});
	strictEqual(makeStub(1805).pendingSkillAction(s), PendingAction.Activate);
});

test('rearmSkill pops the next spare into trigger and reports whether one was left', () => {
	const s = skill({cooldown: 30, spares: [new Region(1500, 1510), new Region(2000, 2010)]});
	const stub = makeStub(1005);
	ok(stub.rearmSkill(s), 'first re-arm succeeds');
	strictEqual(s.trigger.start, 1500);
	ok(stub.rearmSkill(s), 'second re-arm succeeds');
	strictEqual(s.trigger.start, 2000);
	strictEqual(stub.rearmSkill(s), false, 'no spares left');
});

test('a zero-length padding spare can never satisfy a trigger window', () => {
	const s = skill({trigger: new Region(2400, 2400), cooldown: 30, spares: [], cooldownTimer: new Timer(1)});
	strictEqual(makeStub(2400).pendingSkillAction(s), PendingAction.Remove,
		'pos >= trigger.end holds immediately for a zero-length region');
});

test('pendingRemoval wins over a re-arm', () => {
	const s = skill({cooldown: 30, spares: [new Region(1500, 1510)], cooldownTimer: new Timer(1)});
	const stub = makeStub(1005);
	stub.pendingRemoval.add('200331');
	strictEqual(stub.pendingSkillAction(s), PendingAction.Remove);
});

// SKL-21 review (Important 2): the cooldown check must run before the wisdom check, but every
// test above stubs shouldSkipWisdomCheck to always skip it -- none of them actually exercise the
// wisdom branch, so none could catch the two lines being swapped. This test uses a wisdom stub
// that ALWAYS fails, on a candidate that is still cooling down: if cooldown were checked first (as
// it must be), the wisdom stub is never consulted and the result is Rearm. If the order were
// swapped -- wisdom checked before cooldown -- this same candidate would fail its wisdom roll and
// return Remove instead, discarding its remaining spare. Verified by hand that swapping
// RaceSolver.ts's cooldown-check and wisdom-check lines makes this test fail, then swapping them
// back restores the pass (see task-5-report.md).
test('a cooling-down candidate is skipped via cooldown before the wisdom check ever runs', () => {
	const s = skill({
		trigger: new Region(1500, 1510),
		cooldown: 30,
		spares: [new Region(1800, 1810)],
		cooldownTimer: new Timer(-12)   // 12s still to run
	});
	const stub = makeStub(1505, {
		shouldSkipWisdomCheck: (_: PendingSkill) => false,
		checkWisdomForSkill: (_: PendingSkill) => false   // would fail every roll if ever consulted
	});
	strictEqual(stub.pendingSkillAction(s), PendingAction.Rearm,
		'cooldown must be checked before wisdom, so a failing wisdom stub is never reached');
});
