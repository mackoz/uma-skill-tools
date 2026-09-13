import { describe, test, expect } from 'vitest';
import { RaceSolverBuilder, Perspective } from '../RaceSolverBuilder';
import { RaceSolver } from '../RaceSolver';
import { CourseHelpers } from '../CourseData';
import { createFixedPositionPolicy } from '../ActivationSamplePolicy';
import courses from '../data/jp/course_data.json';

// Kyoto 2000m. MUST be distanceType 3 (Mid) -- Murmur is `distance_type==3`, so a Short or
// Mile course would make the first test's drain legitimately zero. getCourse takes a number.
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

	test('adding no debuffs leaves the build byte-identical', () => {
		// Guards the regression checkpoint: addOpponentDebuff must draw no RNG when unused.
		const a = runOnce([]);
		const b = runOnce([]);
		expect(a.hp).toBe(b.hp);
	});

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
		(b as any).onSkillActivate((s: RaceSolver, skillId: string) => {
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
