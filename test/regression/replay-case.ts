// Replays one recorded checkpoint case against the current build and reports how many of its
// samples now differ, alongside the recorded values.
//
// Built for SKL-7's second checkpoint re-record, to answer the question `check.ts` deliberately
// doesn't: *why* does a given case fail? `check.ts --failure-log` names the failing cases; this
// narrows one of them down so you can bisect it (stash a change, re-run, compare) without sitting
// through another full 10000-case run. Re-recording a checkpoint is only safe once every failing
// case has been traced to the change that was supposed to move it -- see
// docs/adr/0013-value-scaling-identity-fallthrough.md's Consequences.
//
// Usage:
//   npx tsx test/regression/replay-case.ts <checkpoint.json> <comma-joined skillsUnderTest>
//
// The skill-id list is the case key: it comes straight out of a failure log's
// `params.skillsUnderTest`. Note a case's *presupposed* skills matter just as much when reasoning
// about which skills a case actually exercises -- SKL-7's own analysis initially missed a case
// because it looked only at skillsUnderTest.

import * as fs from 'fs';

import { RaceSolver } from '../../RaceSolver';
import { makeBuilder } from '../arb/Race';

const [casefile, sutKey] = process.argv.slice(2);
if (!casefile || !sutKey) {
	console.error('usage: replay-case.ts <checkpoint.json> <comma-joined skillsUnderTest>');
	process.exit(2);
}

const cases = JSON.parse(fs.readFileSync(casefile, 'utf-8'));
const matches = cases.filter(c => (c.params.skillsUnderTest || []).join(',') === sutKey);
console.log('matching checkpoint cases: ' + matches.length);

matches.forEach(testCase => {
	const standard = makeBuilder(testCase.params);
	const compare = standard.fork();
	testCase.params.skillsUnderTest.forEach(id => compare.addSkill(id));
	const g1 = compare.build();
	const g2 = standard.build();

	const gains = [];
	for (let i = 0; i < testCase.params.nsamples; ++i) {
		const s1 = g1.next().value as RaceSolver;
		const s2 = g2.next().value as RaceSolver;
		while (s1.pos < standard._course.distance) s1.step(testCase.timestep);
		while (s2.accumulatetime.t < s1.accumulatetime.t) s2.step(testCase.timestep);
		gains.push(s1.pos - s2.pos);
	}

	const differing = gains.filter((g,i) => Math.abs(g - testCase.result.gain[i]) > 1e-9).length;
	console.log('  presupposed: [' + (testCase.params.presupposedSkills || []).join(',') + ']');
	console.log('  nsamples ' + gains.length + ', differing from checkpoint: ' + differing);
	console.log('  first 3 now : ' + JSON.stringify(gains.slice(0,3)));
	console.log('  first 3 file: ' + JSON.stringify(testCase.result.gain.slice(0,3)));
});
