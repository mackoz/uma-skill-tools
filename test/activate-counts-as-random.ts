// UI-34: Course Chart equips each candidate with only its own native unique, so a skill gated on
// a *different* skill having already activated (is_activate_any_skill, activateCountLastFrame >
// 0 in the base condition table) can never satisfy that gate for real -- the counter it reads
// only moves if a second equipped skill fires. conditionsWithActivateCountsAsRandom's
// is_activate_any_skill: noopImmediate entry models it as unconditionally satisfied instead. This
// pins that fix directly against the real skill 120011 (Dreams Donned with Pride!, Global's
// concrete example) and a real course, the same way test/spot-struggle-duration.ts pins its own
// fix against real data rather than a synthetic case.
import test from 'tape';
import { buildBaseStats, buildSkillData, conditionsWithActivateCountsAsRandom, Perspective } from '../RaceSolverBuilder';
import { getParser } from '../ConditionParser';
import { Region, RegionList } from '../Region';
import { RaceState } from '../RaceSolver';
import courseData from '../data/course_data.json';

const SKILL_ID = '120011';
// Any course where phase 2 doesn't coincide with the very start -- 120011's condition is
// phase>=2&is_finalcorner==1&corner!=0&is_activate_any_skill==1, so the region check below
// (test 3) needs a course where "phase >= 2" is a real, non-degenerate subset of the track.
const COURSE_ID = '10101';

const horse = buildBaseStats(
	{
		speed: 1200, stamina: 1200, power: 1200, guts: 1200, wisdom: 1200,
		strategy: 'Senkou', distanceAptitude: 'S', surfaceAptitude: 'S', strategyAptitude: 'S', mood: 2,
	} as any,
	2 as any,
);
const course = (courseData as any)[COURSE_ID];
const wholeCourse = new RegionList();
wholeCourse.push(new Region(0, course.distance));
const racedef = {
	orderRange: [2, 4], numUmas: 9,
	mood: 2, ground: 1, weather: 1, season: 1, time: 1, grade: 1,
} as any;

function buildTrigger(parser: { parse: any; tokenize: any }) {
	const triggers = buildSkillData(horse, racedef, course, wholeCourse, parser, SKILL_ID, Perspective.Self);
	// Exactly one trigger is expected either way -- buildSkillData falls back to an
	// after-course-end placeholder only when every alternative's own region comes up empty
	// (unrelated to this fix), which 120011's plain phase/corner clause never hits.
	if (triggers.length !== 1) {
		throw new Error(`expected exactly 1 trigger for ${SKILL_ID}, got ${triggers.length}`);
	}
	return triggers[0];
}

test('base Conditions table: is_activate_any_skill stays a real dynamic check', t => {
	const trigger = buildTrigger(getParser());
	// This is the pre-fix, still-correct-for-a-full-skill-set behavior: unsatisfied when no prior
	// skill has activated, satisfied once one has. Only activateCountLastFrame is stubbed -- it's
	// the only RaceState field this specific dynamic condition reads.
	t.equal(
		trigger.extraCondition({ activateCountLastFrame: 0 } as unknown as RaceState),
		false,
		'condition is unsatisfied when no prior skill has activated',
	);
	t.equal(
		trigger.extraCondition({ activateCountLastFrame: 1 } as unknown as RaceState),
		true,
		'condition is satisfied once activateCountLastFrame moves -- confirms the stub is wired right, not trivially always-false',
	);
	t.end();
});

test('conditionsWithActivateCountsAsRandom: is_activate_any_skill becomes unconditionally satisfied', t => {
	const trigger = buildTrigger(getParser(conditionsWithActivateCountsAsRandom));
	// The actual fix: with only this one skill equipped (Course Chart's own setup), the counter
	// this condition reads can never move for real -- so under the acr table it must return true
	// regardless of what the counter says, not just when it happens to already be nonzero.
	t.equal(
		trigger.extraCondition({ activateCountLastFrame: 0 } as unknown as RaceState),
		true,
		'condition is satisfied even when no prior skill has (or ever could have) activated',
	);
	t.equal(
		trigger.extraCondition({ activateCountLastFrame: 1 } as unknown as RaceState),
		true,
		'stays satisfied regardless of the counter value',
	);
	t.end();
});

test('conditionsWithActivateCountsAsRandom: region stays bounded by the skill\'s own other clauses', t => {
	const trigger = buildTrigger(getParser(conditionsWithActivateCountsAsRandom));
	// ADR-0010's claim: shadowing is_activate_any_skill as unconditional doesn't mean the trigger
	// fires anywhere -- 120011's own phase>=2&is_finalcorner==1&corner!=0 clauses still bound the
	// region to (part of) phase 2, not the start of the course.
	t.ok(trigger.regions.length > 0, 'a real region was placed');
	t.ok(
		trigger.regions[0].start > 0 && trigger.regions[0].start < course.distance,
		`region start (${trigger.regions[0].start}) falls within the course, not at position 0`,
	);
	t.end();
});
