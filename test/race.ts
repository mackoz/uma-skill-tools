import { program, Option } from 'commander';
import * as fc from 'fast-check';
import { prop, forAll } from './TestHelpers';
import * as arb from './arb/Race';

import { RaceSolver } from '../RaceSolver';

program
	.addOption(new Option('-n, --runs <number>', 'number of runs per property')
		.default(10000)
		.argParser(n => parseInt(n,10)))
	.addOption(new Option('--timestep <dt>', 'integration timestep in seconds')
		.default(1/15, '1/15')
		.argParser(ts => ts.split('/').reduceRight((a,b) => +b / +a, 1.0)));

program.parse();
const options = program.opts();

// A generated RaceParams's presupposed/under-test skills sometimes can't actually be built into a working
// RaceSolver even though the module-load-time skillids filter in test/arb/Race.ts passed them individually:
// some skills gate their whole condition behind a course/order-info precondition the filter can't
// exhaustively probe (see arb.isUnregisteredConditionError's comment -- a known, already-tracked engine gap).
// That is a skill-data/condition-layer failure, not a bug in the race-progression invariants these three
// properties actually check -- each is asserted via an explicit `return false`, never by expecting
// `build()`/`.next()` to throw -- so it is treated as a vacuous case (skip). Every *other* exception is
// rethrown and fails the property: an unexpected throw out of the engine is a real finding, and swallowing
// them wholesale is how SKL-29 (DistributionRandomPolicy.sample() indexing past its region list) stayed
// invisible here until it was hunted down directly.
// `RaceSolverBuilder.build()` is a generator, so the construction work that can throw doesn't actually run
// until the first `.next()` call, not at `.build()` itself -- hence wrapping each property's whole body
// rather than just the `.build()` call.
function skippingUnbuildableScenarios(fn: () => boolean): () => boolean {
	return () => {
		try {
			return fn();
		} catch (e) {
			if (!arb.isUnregisteredConditionError(e)) throw e;
			return true;
		}
	};
}

fc.configureGlobal({numRuns: options.runs});
prop('race should always progress forward', forAll(arb.Race(), params => skippingUnbuildableScenarios(() => {
	const builder = arb.makeBuilder(params);
	const g = builder.build();

	for (let i = 0; i < params.nsamples; ++i) {
		const s = g.next().value as RaceSolver;
		let lastPos = 0;
		let lastT = 0;
		while (s.pos < builder._course.distance) {
			s.step(options.timestep);
			if (s.accumulatetime.t <= lastT || (s.pos <= lastPos && !(s.accumulatetime.t < s.startDelay))) {
				return false;
			}
			lastPos = s.pos;
			lastT = s.accumulatetime.t;
		}
	}

	return true;
})()));

prop('position should always be defined', forAll(arb.Race(), params => skippingUnbuildableScenarios(() => {
	const builder = arb.makeBuilder(params);
	const g = builder.build();

	for (let i = 0; i < params.nsamples; ++i) {
		const s = g.next().value as RaceSolver;
		while (s.pos < builder._course.distance) {
			s.step(options.timestep);
			if (isNaN(s.pos)) {
				return false;
			}
		}
	}
	return true;
})()));

prop('identical race solvers should always stay in sync', forAll(arb.Race(), params => skippingUnbuildableScenarios(() => {
	const b1 = arb.makeBuilder(params);
	const b2 = b1.fork();
	const g1 = b1.build();
	const g2 = b2.build();

	for (let i = 0; i < params.nsamples; ++i) {
		const s1 = g1.next().value as RaceSolver;
		const s2 = g2.next().value as RaceSolver;

		while (s1.pos < b1._course.distance) {
			s1.step(options.timestep);
			s2.step(options.timestep);
			if (s1.pos != s2.pos) {
				return false;
			}
		}
	}
	return true;
})()));
