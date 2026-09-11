// SKL-21 review (Important 1): doActivateRandomGold() force-picks a Gold/Evolution pending skill
// by index, bypassing the normal pendingSkillAction()/cooldown gate entirely. Before cooldowns
// existed this was harmless -- activateSkill() was always immediately followed by splice, so a
// skill could never be picked twice. Now a cooldown skill survives its own activation and stays in
// pendingSkills, so without an explicit guard a still-cooling entry (cooldownTimer.t < 0) could be
// force-picked again moments after its real activation. This pins the fix: a cooling-down
// candidate must be excluded from the pool doActivateRandomGold draws from, while one whose
// cooldown has actually expired (cooldownTimer.t >= 0, or no cooldown at all) stays eligible.
import { test } from 'vitest';
import { deepStrictEqual } from 'node:assert/strict';
import { RaceSolver, PendingSkill, SkillRarity, SkillType, Timer } from '../RaceSolver';
import { Region } from '../Region';
import { attachMethods } from './RaceSolverTestHelpers';

function goldSkill(skillId: string, overrides: Partial<PendingSkill> = {}): PendingSkill {
	return {
		skillId,
		rarity: SkillRarity.Gold,
		trigger: new Region(0, 1),
		extraCondition: () => true,
		effects: [{type: SkillType.TargetSpeed, baseDuration: 1, modifier: 1, valueUsage: 1, timeUsage: 1}],
		...overrides
	} as PendingSkill;
}

// doActivateRandomGold shuffles candidates with this.gorosiRng before picking -- a stub that
// always returns 0 leaves the reduce-built index order untouched, so the test can reason about
// which skillIds got activated without caring about shuffle order.
function makeStub(pendingSkills: PendingSkill[]) {
	const activated: string[] = [];
	return Object.assign(
		attachMethods({
			pendingSkills,
			pendingRemoval: new Set<string>(),
			gorosiRng: {uniform: (_n: number) => 0} as any,
			activateSkill: (s: PendingSkill) => { activated.push(s.skillId); }
		}, 'doActivateRandomGold'),
		{activated}
	);
}

test('a still-cooling Gold skill is not selected by the forced-activation path', () => {
	const cooling = goldSkill('105501211', {cooldown: 30, cooldownTimer: new Timer(-29.9)});
	const stub = makeStub([cooling]);
	stub.doActivateRandomGold(1);
	deepStrictEqual(stub.activated, [], 'the only candidate is still cooling down and must not be picked');
});

test('a Gold skill whose cooldown has expired is still selected by the forced-activation path', () => {
	const expired = goldSkill('105501211', {cooldown: 30, cooldownTimer: new Timer(0.1)});
	const stub = makeStub([expired]);
	stub.doActivateRandomGold(1);
	deepStrictEqual(stub.activated, ['105501211'], 'an expired cooldown must not block the forced path');
});

test('a Gold skill that has never had a cooldown timer set is still selected', () => {
	const neverFired = goldSkill('105501211', {cooldown: 30});
	const stub = makeStub([neverFired]);
	stub.doActivateRandomGold(1);
	deepStrictEqual(stub.activated, ['105501211'], 'a null cooldownTimer (never fired yet) is eligible');
});

test('a cooling candidate is skipped in favor of an eligible one in the same pool', () => {
	const cooling = goldSkill('105501211', {cooldown: 30, cooldownTimer: new Timer(-29.9)});
	const eligible = goldSkill('108201111', {cooldown: 30, cooldownTimer: new Timer(0.1)});
	const stub = makeStub([cooling, eligible]);
	stub.doActivateRandomGold(1);
	deepStrictEqual(stub.activated, ['108201111']);
});
