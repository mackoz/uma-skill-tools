// SKL-21: the regression checkpoint was re-recorded (see the commit immediately after this file's
// first commit) because skills that carry a real in-game `cooldown` now re-activate instead of
// being dropped after their first window -- a deliberate behavior change, not a regression. That
// makes the ordinary "checkpoint matches bit-for-bit" gate (test/regression/check.ts) useless for
// telling a legitimate cooldown-driven move apart from an accidental one everywhere else: once the
// checkpoint is re-recorded against the new engine, check.ts passes trivially for every case,
// cooldown or not.
//
// This test replays the checkpoint's OWN recorded cases (whichever checkpoint happens to be
// latest, same file check.ts itself reads): a case that exercises no cooldown-bearing skill must
// reproduce its recorded `gain` values exactly. Against the CURRENT baseline (re-recorded for this
// behavior change) that partition is 0 diverged on both sides, cooldown and non-cooldown alike --
// check.ts already makes that same statement for every case, so this test is NOT a stronger
// guarantee than check.ts today. What it adds instead: it is pinned to run every time, on a fixed
// deterministic sample, with the non-cooldown/cooldown split broken out explicitly, so a future
// change that makes a non-cooldown case start diverging again (the actual regression this guards
// against) is caught immediately and attributed correctly, rather than needing another one-off
// partition script re-run by hand.
//
// The partition that originally justified re-recording the checkpoint was measured against the
// OLD (pre-SKL-21) baseline, which this checkpoint replaced and which no longer exists in the
// working tree (renamed away by the commit that replaced it). It is still reproducible, not lost:
//   git show c3954ab:test/regression/checkpoints/20260909.5ecc3aa.2432198835.json
// (c3954ab is this branch's merge-base, the last commit before any SKL-21 change). Replaying this
// file's logic against that recovered checkpoint reproduces the numbers the re-record was
// authorized on: non-cooldown 233 checked / 0 diverged; cooldown 66 checked / 9 diverged -- i.e.
// the only cases the cooldown re-arm touched were cases that actually contain a cooldown-bearing
// skill. (Those counts come from the fix-round re-reviewer's full-partition replay, not this file's
// own SampleSize=300 sample, which is why they don't match this file's own sample sizes.)
import { test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { makeBuilder } from '../arb/Race';
import { RaceSolver } from '../../RaceSolver';
import { Rule30CARng } from '../../Random';
import skillData from '../../data/jp/skill_data.json';

// Same tolerance check.ts uses for "close enough to count as the same result".
const Epsilon = 5e11 * Number.EPSILON;
function almostEqual(a: number, b: number) {
	if (a == b) return true;
	return Math.abs(a - b) < Math.max(Epsilon * (Math.abs(a) + Math.abs(b)), Number.EPSILON);
}

// Mirrors check.ts's own getLatestCheckpoint(): sort the checkpoint directory by the date encoded
// in the filename and take the newest. Deliberately not imported from check.ts -- that module runs
// itself as a tape test as a side effect of being loaded, which would double-run it under vitest.
function getLatestCheckpoint(): string {
	const dir = path.join(__dirname, 'checkpoints');
	return fs.readdirSync(dir)
		.map(f => [path.join(dir, f), Date.parse(f.split('.', 1)[0].replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'))] as [string, number])
		.sort((a, b) => b[1] - a[1])[0][0];
}

// Cooldown-bearing skill ids, derived from the data itself (not hardcoded) so this keeps working as
// skill_data.json is regenerated and the set of cooldown skills grows.
const cooldownSkillIds = new Set(
	Object.keys(skillData).filter(id => (skillData as any)[id].alternatives.some((alt: any) => 'cooldown' in alt))
);

// SKL-21 review (Important 4): cooldown/spares are gated per PendingSkill *entry*, not per
// skillId -- RaceSolverBuilder.ts@second-trigger-detail-guard can place a second trigger entry
// sharing the same skillId (its own condition must match is_activate_other_skill_detail or
// is_used_skill_id) alongside a first entry, and each entry is an independent candidate for the
// ceiling test below to count via its skillId alone. JP skill `408061` is the one concrete case
// today: one entry carries `cooldown: 30` (placed via all_corner_random, gets spares), the other
// has no cooldown at all (placed via is_activate_other_skill_detail, gets none) -- the cooldown
// entry's own re-arms plus the detail entry's own single activation both count against the same
// skillId under onSkillActivate's signature, which reports only a skillId, not which entry fired.
// A sampled 408061 could legitimately reach up to MaxActivationsWithCooldown + 1 activations (one
// from the detail entry, the rest from the cooldown entry re-arming) without any bug at all --
// latent today only because no sampled case has hit it (max observed for this skill: 2), but a
// future sample or a wider corpus could. Final review judged per-entry (rather than per-skillId)
// gating here probably CORRECT, not a limitation: 408061's second alternative is an
// is_activate_other_skill_detail follow-on with no cooldown of its own, so gating the cooldown
// entry independently of it is the right behavior, not a compromise. It is counting per skillId in
// THIS TEST -- a test-side simplification, not the underlying gating -- that can't tell the two
// entries' activations apart, so skills with more than one trigger entry are excluded from the
// ceiling check below rather than risk a false red on a non-bug.
const multiEntrySkillIds = new Set(
	Object.keys(skillData).filter(id => {
		const alts = (skillData as any)[id].alternatives;
		if (alts.length < 2) return false;
		// Mirrors second-trigger-detail-guard's own condition check (not its region-placement
		// logic, which needs a course/horse this file doesn't have) -- conservative by
		// construction: an alternative whose condition doesn't match the detail/used-skill regex
		// would be skipped by the real guard too, so this can only ever overcount which skillIds
		// might place more than one entry, never undercount.
		let triggerCount = 1;
		for (let i = 1; i < alts.length; i++) {
			if (/is_activate_other_skill_detail|is_used_skill_id/.test(alts[i].condition)) triggerCount++;
		}
		return triggerCount > 1;
	})
);

const allCases = JSON.parse(fs.readFileSync(getLatestCheckpoint(), 'utf-8'));

// Bounded, deterministic sample rather than all ~10000 cases: check.ts's own --fast mode already
// establishes that 100 cases is enough to catch a real draw-count/behavior regression in practice,
// and replaying a case (building two solvers and stepping them to the finish) is the expensive
// part here, same as in check.ts. 300 gives a healthier margin for the "zero non-cooldown
// divergence" claim specifically (it's a single hard assertion, not a percentage) while keeping
// this test a few seconds, not a few minutes. The shuffle uses a fixed seed, unlike check.ts's
// random default, so the sample -- and therefore this test's pass/fail -- is reproducible across
// runs and CI machines.
const SampleSize = 300;
const ShuffleSeed = 0x5c121;

function sampleCases<T>(cases: T[], n: number, seed: number): T[] {
	const shuffled = cases.slice();
	const rng = new Rule30CARng(seed);
	for (let i = shuffled.length; --i >= 0;) {
		const j = rng.uniform(i + 1);
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}
	return shuffled.slice(0, n);
}

function involvedSkillIds(params: any): string[] {
	return [...(params.skillsUnderTest ?? []), ...(params.presupposedSkills ?? [])].map(String);
}

function replayMatchesRecording(testCase: any): boolean {
	const standard = makeBuilder(testCase.params);
	const compare = standard.fork();
	testCase.params.skillsUnderTest.forEach((id: string) => compare.addSkill(id));
	const g1 = compare.build();
	const g2 = standard.build();
	for (let i = 0; i < testCase.params.nsamples; ++i) {
		const s1 = g1.next().value as RaceSolver;
		const s2 = g2.next().value as RaceSolver;
		while (s1.pos < (standard as any)._course.distance) s1.step(testCase.timestep);
		while (s2.accumulatetime.t < s1.accumulatetime.t) s2.step(testCase.timestep);
		if (!almostEqual(s1.pos - s2.pos, testCase.result.gain[i])) return false;
	}
	return true;
}

test('no case without a cooldown-bearing skill diverges from the checkpoint', () => {
	const sample = sampleCases(allCases, SampleSize, ShuffleSeed);
	const offenders: string[] = [];
	let nonCooldownChecked = 0;

	sample.forEach((testCase: any, i: number) => {
		if (involvedSkillIds(testCase.params).some(id => cooldownSkillIds.has(id))) return;
		nonCooldownChecked++;
		let matches = false;
		let caught = false;
		try {
			matches = replayMatchesRecording(testCase);
		} catch (_) {
			caught = true;
		}
		// SKL-21 review (Minor 5, upgraded to must-fix): a bare `catch { matches = true }` treats
		// every throw as a pass without checking whether a throw was actually expected here -- a
		// newly-introduced throw (e.g. a regression that makes the engine blow up on a case that
		// used to build and run fine) would be silently swallowed and invisible, in the one test
		// that is the entire justification for re-recording the checkpoint baseline. check.ts's own
		// `testCase.result.err` records whether recording this case threw; a build/replay throw is
		// symmetric between the standard/compare builders by construction (both sides are built
		// from the same params), so whether THIS replay throws must match that recorded flag
		// exactly, not just "some throw happened, treat it as fine."
		const expectedToThrow = !!testCase.result.err;
		if (caught !== expectedToThrow) {
			offenders.push(`case ${i}: threw=${caught}, expected threw=${expectedToThrow} (testCase.result.err)`);
		} else if (!caught && !matches) {
			offenders.push(`case ${i}: diverged from recorded gain values`);
		}
	});

	// Guard against the sample accidentally containing no non-cooldown cases at all, which would
	// make the assertion below vacuously true and useless.
	expect(nonCooldownChecked).toBeGreaterThan(0);
	expect(offenders, `cases diverged with no cooldown-bearing skill involved:\n${offenders.join('\n')}`).toEqual([]);
}, 30000);

// SKL-21: the checkpoint divergence's magnitude has a long tail -- traced by hand for the single
// largest offender (see the task-5-report.md discussion this test is named after), but tracing
// each remaining large case by hand proves nothing about the next one and is unbounded work. This
// is the structural invariant that subsumes all of them: bound how many times any one (skill,
// race) pair can possibly activate, so a magnitude outlier can only ever be an "occasional extra
// activation," never a runaway re-arm. If this test ever fails, that changes the picture
// completely -- a real bug, not sensitivity in an already-volatile gain metric -- and the ceiling
// must not be loosened to make it pass.
//
// Ceiling only, deliberately no floor: an earlier version of this test also asserted "a skill
// without a cooldown never activates more than once" and that assertion was wrong, not this
// engine. Skills like `901311` and `106202221` have two `alternatives` with no `cooldown` on
// either, where the second alternative's condition matches `is_activate_other_skill_detail` or
// `is_used_skill_id` -- RaceSolverBuilder.ts@second-trigger-detail-guard deliberately keeps both
// as separate trigger entries sharing one skillId in that case, each independently eligible to
// activate once, which legitimately produces 2 (observed up to 4 in one case) activations of the
// same skillId with no cooldown involved anywhere. Confirmed pre-existing by replaying the
// checkpoint against this branch's merge-base (`c3954ab`, no SKL-21 commits present) in a scratch
// worktree: the same skills hit the same counts there. The non-cooldown guarantee this test
// actually needs is already covered, and covered more strongly, by the first test in this file: it
// replays every sampled non-cooldown case end-to-end and requires its *result* to match the
// checkpoint exactly, and identical results necessarily imply identical activation counts. A
// narrower "once per PendingSkill entry" floor here would just restate something already true by
// construction and already checked there -- so there is deliberately no floor assertion in this
// test. (Skills with more than one trigger entry are excluded from the ceiling check below too,
// for the unrelated reason given at multiEntrySkillIds's own definition above -- per-skillId
// counting can't tell their entries apart.)
test('no (skill, race) pair with a cooldown ever activates more than 1 + SPARES times', () => {
	// RaceSolverBuilder.ts@skl-21-spares-count declares `const SPARES = 3` (duplicated, with the
	// same value, at the pacer path in prepPacerTriggers()) -- not exported, so this ceiling is
	// hardcoded and named here instead. If either declaration's value changes, this must change
	// with it.
	const Spares = 3;
	const MaxActivationsWithCooldown = 1 + Spares;

	const sample = sampleCases(allCases, SampleSize, ShuffleSeed);
	let maxObservedWithCooldown = 0;
	const offenders: string[] = [];

	sample.forEach((testCase: any, i: number) => {
		try {
			const standard = makeBuilder(testCase.params);
			const compare = standard.fork();
			testCase.params.skillsUnderTest.forEach((id: string) => compare.addSkill(id));

			const counts = new Map<string, number>();
			compare.onSkillActivate((_state: any, skillId: string) => {
				counts.set(skillId, (counts.get(skillId) ?? 0) + 1);
			});

			const g1 = compare.build(), g2 = standard.build();
			for (let s = 0; s < testCase.params.nsamples; ++s) {
				counts.clear();
				const s1 = g1.next().value as RaceSolver, s2 = g2.next().value as RaceSolver;
				while (s1.pos < (standard as any)._course.distance) s1.step(testCase.timestep);
				while (s2.accumulatetime.t < s1.accumulatetime.t) s2.step(testCase.timestep);

				counts.forEach((count, skillId) => {
					if (!cooldownSkillIds.has(skillId)) return;
					// SKL-21 review (Important 4): a multi-entry skillId's count is a sum across
					// entries onSkillActivate can't distinguish, so it can't be checked against a
					// single-entry ceiling without risking a false red on a non-bug -- see
					// multiEntrySkillIds's own comment above.
					if (multiEntrySkillIds.has(skillId)) return;
					maxObservedWithCooldown = Math.max(maxObservedWithCooldown, count);
					if (count > MaxActivationsWithCooldown) {
						offenders.push(`case ${i} sample ${s}: skill ${skillId} activated ${count} times, ceiling ${MaxActivationsWithCooldown}`);
					}
				});
			}
		} catch (_) {
			// Build/replay throws are pre-existing and symmetric between the two builders; not this
			// test's concern (cooldown-partition.test.ts's first test already tolerates them the
			// same way).
		}
	});

	// SKL-21 review (Important 2): the ceiling is headroom, not something this sample reaches --
	// don't claim otherwise. With cooldown now distance-scaled (Cooldown = 30 * distance/1000
	// seconds) and every cooldown in the current data equal to 30, the achievable activation count
	// is distance-INVARIANT: scaledCooldown/raceDuration ~= (30*d/1000) / (d/17) = 30*17/1000 ~=
	// 0.51 for any course length d (race duration approximated at ~17 m/s average pace, d cancels
	// out), so a race is only ever "worth" about two cooldown windows (1 primary + ~1 re-arm)
	// regardless of how long the course is. That matches what's actually observed here --
	// max activations is consistently 2, never close to the ceiling of 4 -- and it structurally
	// resolves the earlier "SPARES=3 may be too low for a long course" concern (distance-scaling
	// made the achievable count distance-invariant, not distance-growing, so a longer course no
	// longer needs more spares than a short one). SPARES=3 stays because it matches
	// all_corner_random's own four-point roll (conditions.md:125), not because anything here is
	// close to using all of it.
	console.log(`max activations observed for a cooldown skill: ${maxObservedWithCooldown} (ceiling: ${MaxActivationsWithCooldown})`);
	expect(offenders, `activation-count ceiling violated:\n${offenders.join('\n')}`).toEqual([]);
}, 30000);
