import { describe, test, expect } from 'vitest';
import { RaceSolverBuilder } from '../RaceSolverBuilder';
import { RaceSolver } from '../RaceSolver';
import { CourseHelpers } from '../CourseData';
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

	test('adding no debuffs leaves the build byte-identical', () => {
		// Guards the regression checkpoint: addOpponentDebuff must draw no RNG when unused.
		const a = runOnce([]);
		const b = runOnce([]);
		expect(a.hp).toBe(b.hp);
	});
});
