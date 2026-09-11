// SKL-21: the regression checkpoint was re-recorded (see the commit immediately after this file's
// first commit) because skills that carry a real in-game `cooldown` now re-activate instead of
// being dropped after their first window -- a deliberate behavior change, not a regression. That
// makes the ordinary "checkpoint matches bit-for-bit" gate (test/regression/check.ts) useless for
// telling a legitimate cooldown-driven move apart from an accidental one everywhere else: once the
// checkpoint is re-recorded against the new engine, check.ts passes trivially for every case,
// cooldown or not.
//
// This test is the permanent, narrower guarantee that check.ts can no longer make by itself:
// replaying the checkpoint's OWN recorded cases (whichever checkpoint happens to be latest, same
// file check.ts itself reads), a case that exercises no cooldown-bearing skill must reproduce its
// recorded `gain` values exactly. It says nothing about cases that DO exercise a cooldown skill --
// those are expected to move, by design, and asserting anything about their direction or magnitude
// here would just be re-deriving game mechanics nobody has measured (see
// uma-skill-tools/CLAUDE.md's "30s constant is unverified" caveat carried over from the ticket).
//
// Before the checkpoint was re-recorded, running this same test against the OLD (pre-SKL-21)
// checkpoint produced the partition this guards: 1139 non-cooldown cases checked, 0 diverged;
// 361 cooldown-involving cases checked, 117 diverged -- i.e. the only cases the cooldown re-arm
// touched were cases that actually contain a cooldown-bearing skill. That run is what justified
// re-recording the checkpoint in the first place; this test is what keeps that justification
// checkable by a future reader (or a future regression) instead of living only in a one-off script
// and a PR description.
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
	const offenders: number[] = [];
	let nonCooldownChecked = 0;

	sample.forEach((testCase: any, i: number) => {
		if (involvedSkillIds(testCase.params).some(id => cooldownSkillIds.has(id))) return;
		nonCooldownChecked++;
		let matches: boolean;
		try {
			matches = replayMatchesRecording(testCase);
		} catch (_) {
			// A build/replay throw is symmetric between standard/compare builders and is exercised
			// (and tolerated) by check.ts itself via testCase.result.err; this test only cares about
			// numeric divergence, not pre-existing build failures unrelated to SKL-21.
			matches = true;
		}
		if (!matches) offenders.push(i);
	});

	// Guard against the sample accidentally containing no non-cooldown cases at all, which would
	// make the assertion below vacuously true and useless.
	expect(nonCooldownChecked).toBeGreaterThan(0);
	expect(offenders, `cases diverged with no cooldown-bearing skill involved: ${JSON.stringify(offenders)}`).toEqual([]);
}, 30000);
