import { describe, test, expect } from 'vitest';
import { RaceSolverBuilder, Perspective } from '../RaceSolverBuilder';
import { RaceSolver } from '../RaceSolver';
import { CourseHelpers } from '../CourseData';
import { createFixedPositionPolicy } from '../ActivationSamplePolicy';
import courses from '../data/jp/course_data.json';

// Sapporo 2000m (course_data.json's 10104 has raceTrackId 10001, which tracknames.json maps to
// 札幌/Sapporo). MUST be distanceType 3 (Mid) -- Murmur is `distance_type==3`, so a Short or Mile
// course would make the first test's drain legitimately zero. getCourse takes a number.
const COURSE_ID = 10104;
const horse = {
	speed: 1000, stamina: 1000, power: 1000, guts: 1000, wisdom: 1000,
	strategy: 'Senkou', distanceAptitude: 'A', surfaceAptitude: 'A', strategyAptitude: 'A',
	mood: 2, skills: []
};

function runOnce(debuffs: string[]) {
	const b = new RaceSolverBuilder(1).seed(12345)
		.course(CourseHelpers.getCourse(COURSE_ID))
		.mode('compare')
		.horse(horse as any);
	for (const id of debuffs) b.addOpponentDebuff(id);
	const s = b.build().next(false).value as RaceSolver;
	s.initUmas([]);
	const maxHp = (s.hp as any).maxHp;
	while (s.pos < s.course.distance) s.step(1 / 15);
	return { maxHp, hp: (s.hp as any).hp };
}

function runOnceSeeded(debuffs: string[], seed: number) {
	const b = new RaceSolverBuilder(1).seed(seed)
		.course(CourseHelpers.getCourse(COURSE_ID))
		.mode('compare')
		.horse(horse as any);
	for (const id of debuffs) b.addOpponentDebuff(id);
	const s = b.build().next(false).value as RaceSolver;
	s.initUmas([]);
	const maxHp = (s.hp as any).maxHp;
	while (s.pos < s.course.distance) s.step(1 / 15);
	return { maxHp, hp: (s.hp as any).hp };
}

function runOnceWithStrategy(strategy: string, debuffs: string[]) {
	const b = new RaceSolverBuilder(1).seed(12345)
		.course(CourseHelpers.getCourse(COURSE_ID))
		.mode('compare')
		.horse({ ...horse, strategy } as any);
	for (const id of debuffs) b.addOpponentDebuff(id);
	const s = b.build().next(false).value as RaceSolver;
	s.initUmas([]);
	const maxHp = (s.hp as any).maxHp;
	while (s.pos < s.course.distance) s.step(1 / 15);
	return { maxHp, hp: (s.hp as any).hp };
}

describe('addOpponentDebuff', () => {
	test('N copies of a 1% debuff remove N% of maxHp relative to a clean run', () => {
		const clean = runOnce([]);
		const one = runOnce(['201162']);        // Murmur, 1%
		const two = runOnce(['201162', '201162']);
		expect(clean.maxHp).toBeGreaterThan(0);
		expect(one.maxHp).toBeCloseTo(clean.maxHp, 6);
		expect(clean.hp - one.hp).toBeCloseTo(clean.maxHp * 0.01, 4);
		expect(clean.hp - two.hp).toBeCloseTo(clean.maxHp * 0.02, 4);
	});

	test('a debuff whose caster terms would exclude the victim still fires', () => {
		// All-Seeing Eyes requires the CASTER to be a Late Surger; this horse is a Pace Chaser.
		const clean = runOnce([]);
		const hit = runOnce(['201441']);        // 3%
		expect(clean.hp - hit.hp).toBeCloseTo(clean.maxHp * 0.03, 4);
	});

	test('a debuff using an unregistered caster condition does not throw', () => {
		expect(() => runOnce(['200771'])).not.toThrow();   // temptation_opponent_count_behind
	});

	test('an incoming debuff is not subject to the wisdom roll', () => {
		// skillWisdomCheck defaults on; a White-rarity non-green skill would otherwise roll.
		// Run across many seeds: every one must show the full drain.
		for (let seed = 1; seed <= 25; ++seed) {
			const clean = runOnceSeeded([], seed);
			const hit = runOnceSeeded(['201162'], seed);
			expect(clean.hp - hit.hp).toBeCloseTo(clean.maxHp * 0.01, 4);
		}
	});

	// HP-7 review-4 (M2): the previous version of this test ran runOnce([]) twice and compared the
	// two results -- true by construction of the seeded builder regardless of whether
	// addOpponentDebuff draws RNG when unused, so it asserted nothing. The real guard against
	// addOpponentDebuff drawing RNG when the debuff list is empty is test/regression/check.ts's
	// full checkpoint replay (956,108 assertions across the fixed-seed corpus), which would fail if
	// an unused code path started consuming RNG and shifting every subsequent draw.

	// HP-7 review-3 fix 1 (Important): _samplePolicyOverride is keyed only by `${skillId}:${perspective}`
	// (getSamplePolicyKey), so addSkillAtPosition's forced-position policy and addOpponentDebuff's
	// victim-safe RandomPolicy collide whenever the same skill id/perspective pair is used both ways
	// on the same builder -- exactly what happens in umalator/compare.ts when uma A's own equipped
	// debuff is forced to a position via the always-visible "Force @ position" input (which calls
	// addSkillAtPosition(id, pos, Perspective.Other, ...) on uma B's builder) while uma B's Stam
	// Debuff dialog separately configures that same skill id as an incoming debuff on that same
	// builder (addOpponentDebuff(id), also Perspective.Other). Before the fix, the forced-position
	// override silently won for the debuff triggers too, collapsing every sampled activation onto
	// the forced point.
	test('a victim-safe debuff\'s RandomPolicy is not hijacked by a forced-position skill sharing its key', () => {
		const FORCED_POS = 500;
		const b = new RaceSolverBuilder(1).seed(99)
			.course(CourseHelpers.getCourse(COURSE_ID))
			.mode('compare')
			.horse(horse as any);
		// Same skill id and perspective as the addOpponentDebuff calls below -- shares
		// getSamplePolicyKey('201162', Perspective.Other) with them. Equivalent to
		// addSkillAtPosition('201162', FORCED_POS, Perspective.Other), written out via addSkill's
		// explicit samplePolicy parameter since addSkillAtPosition's internal require() of
		// './ActivationSamplePolicy' doesn't resolve under vitest's ESM loader.
		b.addSkill('201162', Perspective.Other, createFixedPositionPolicy(FORCED_POS));
		b.addOpponentDebuff('201162');
		b.addOpponentDebuff('201162');

		const activations: number[] = [];
		b.onSkillActivate((s: RaceSolver, skillId: string) => {
			if (skillId === '201162') activations.push(s.pos);
		});

		const s = b.build().next(false).value as RaceSolver;
		s.initUmas([]);
		while (s.pos < s.course.distance) s.step(1 / 15);

		expect(activations.length).toBe(3);
		// Exactly the genuinely forced-position instance should land near FORCED_POS (the exact
		// distance is quantized by the fixed 1/15s step, not a bare position check) -- the two
		// addOpponentDebuff instances must keep their own (RandomPolicy) trigger points instead of
		// collapsing onto it. Before the fix, all three landed within a step of FORCED_POS.
		const nearForcedPos = activations.filter(pos => Math.abs(pos - FORCED_POS) < 5);
		expect(nearForcedPos.length).toBe(1);
	});
});

// HP-7 review-3 fix 8 (Important): every other test in this file uses a single fixed Senkou
// horse throughout -- nothing exercised a running-style-gated debuff (SkillTarget.EnemyStrategy,
// a running_style_count_*_otherself condition term) against horses of DIFFERENT actual running
// styles through the real RaceSolver pipeline, so nothing here would have caught a regression
// reintroducing the exact bug the victim-safe allowlist fix corrected (running_style_count_*
// wrongly stripped as "caster state" -- see docs/adr/0014's peer-review-fix history). 200831
// (Subdued, target 18/EnemyStrategy, `running_style_count_nige_otherself>=1&phase_random==0&
// accumulatetime>=5`, distance_type-unrestricted, 1% drain) is the smallest member of that family.
describe('addOpponentDebuff running-style gating (target-18 debuffs)', () => {
	test('a Nige-gated debuff drains a Nige horse', () => {
		const clean = runOnceWithStrategy('Nige', []);
		const hit = runOnceWithStrategy('Nige', ['200831']);
		expect(clean.hp - hit.hp).toBeCloseTo(clean.maxHp * 0.01, 4);
	});

	test('a Nige-gated debuff does NOT drain a Senkou (Pace Chaser) horse', () => {
		const clean = runOnceWithStrategy('Senkou', []);
		const hit = runOnceWithStrategy('Senkou', ['200831']);
		expect(clean.hp - hit.hp).toBeCloseTo(0, 4);
	});

	// strategyMatches() treats Oonige as interchangeable with Nige (ANCHOR
	// strategy-matches-oonige-nige, HorseTypes.ts) -- an Oonige victim must be drained exactly
	// like a Nige one by a Nige-gated debuff.
	test('a Nige-gated debuff also drains an Oonige horse', () => {
		const clean = runOnceWithStrategy('Oonige', []);
		const hit = runOnceWithStrategy('Oonige', ['200831']);
		expect(clean.hp - hit.hp).toBeCloseTo(clean.maxHp * 0.01, 4);
	});
});

// HP-7 review-4 (C1, Critical): doActivateRandomGold()'s goldIndices predicate used to check only
// rarity and effect type, so any victim carrying a SkillType.ActivateRandomGold (37) effect (e.g.
// 110071, Summer Goldship's unique "Adventure of 564") could force-activate a pending incoming
// debuff -- outside its real proc window, and since pendingRemoval is a Set keyed by bare skillId,
// only one of N same-id configured copies got removed, so a surviving copy fired again later (N+1
// drains). The fix adds `!skill.victimSafe` to the predicate.
describe('addOpponentDebuff is immune to ActivateRandomGold force-activation (C1)', () => {
	test('2 configured copies of a gold incoming debuff still activate exactly twice, inside their real window, when the victim carries an ActivateRandomGold skill', () => {
		const course = CourseHelpers.getCourse(COURSE_ID);
		// phase_random==2 window for All-Seeing Eyes (201441) on this 2000m course.
		const windowStart = CourseHelpers.phaseStart(course.distance, 2);
		const windowEnd = CourseHelpers.phaseEnd(course.distance, 2);

		const b = new RaceSolverBuilder(1).seed(1)
			.course(course)
			.mode('compare')
			.skillWisdomCheck(false)
			.horse(horse as any);
		// Forced early (well before the phase-2 window) so that if 201441 were still
		// force-activatable, it would fire here instead of its real window. Written out via addSkill's
		// explicit samplePolicy parameter rather than addSkillAtPosition -- see the comment on the
		// collision test above about its internal require() not resolving under vitest's ESM loader.
		b.addSkill('110071', Perspective.Self, createFixedPositionPolicy(100));
		b.addOpponentDebuff('201441');
		b.addOpponentDebuff('201441');

		const activations: number[] = [];
		b.onSkillActivate((s: RaceSolver, skillId: string) => {
			if (skillId === '201441') activations.push(s.pos);
		});

		const s = b.build().next(false).value as RaceSolver;
		s.initUmas([]);
		while (s.pos < s.course.distance) s.step(1 / 15);

		expect(activations.length).toBe(2);
		for (const pos of activations) {
			expect(pos).toBeGreaterThanOrEqual(windowStart);
			expect(pos).toBeLessThanOrEqual(windowEnd);
		}
	});
});

// HP-7 review-4 (M7): the feature's headline claim is that a debuff fires at its REAL proc window
// -- the only positional assertion in this file before this was the forced-position collision
// test's `Math.abs(pos - 500) < 5`. These pin an early-phase debuff (Murmur, phase 1) and a
// late-phase debuff (All-Seeing Eyes, phase 2) each landing inside the window
// victimSafeCondition() actually computes, which is the one assertion class that would have caught
// C1's out-of-window firing on its own.
describe('addOpponentDebuff activates inside its real proc window (M7)', () => {
	test('Murmur (201162) activates inside phase 1', () => {
		const course = CourseHelpers.getCourse(COURSE_ID);
		const windowStart = CourseHelpers.phaseStart(course.distance, 1);
		const windowEnd = CourseHelpers.phaseEnd(course.distance, 1);

		const b = new RaceSolverBuilder(1).seed(1)
			.course(course)
			.mode('compare')
			.horse(horse as any);
		b.addOpponentDebuff('201162');

		const activations: number[] = [];
		b.onSkillActivate((s: RaceSolver, skillId: string) => {
			if (skillId === '201162') activations.push(s.pos);
		});

		const s = b.build().next(false).value as RaceSolver;
		s.initUmas([]);
		while (s.pos < s.course.distance) s.step(1 / 15);

		expect(activations.length).toBe(1);
		expect(activations[0]).toBeGreaterThanOrEqual(windowStart);
		expect(activations[0]).toBeLessThan(windowEnd);
	});

	test('All-Seeing Eyes (201441) activates inside phase 2', () => {
		const course = CourseHelpers.getCourse(COURSE_ID);
		const windowStart = CourseHelpers.phaseStart(course.distance, 2);
		const windowEnd = CourseHelpers.phaseEnd(course.distance, 2);

		const b = new RaceSolverBuilder(1).seed(1)
			.course(course)
			.mode('compare')
			.horse(horse as any);
		b.addOpponentDebuff('201441');

		const activations: number[] = [];
		b.onSkillActivate((s: RaceSolver, skillId: string) => {
			if (skillId === '201441') activations.push(s.pos);
		});

		const s = b.build().next(false).value as RaceSolver;
		s.initUmas([]);
		while (s.pos < s.course.distance) s.step(1 / 15);

		expect(activations.length).toBe(1);
		expect(activations[0]).toBeGreaterThanOrEqual(windowStart);
		expect(activations[0]).toBeLessThan(windowEnd);
	});
});
