// Shared scaffolding for RaceSolver mechanics tests. The pattern all of these tests share: build
// a minimal stand-in object carrying only the instance fields the method(s) under test actually
// touch, and call the real RaceSolver.prototype method(s) against it with .call() -- rather than
// constructing a full RaceSolver (course/horse/skills/builder machinery), which is covered
// separately by test/race.ts and is overkill for pinning one isolated mechanic. Extracted from
// test/rushed-escape-roll.test.ts (DYN-11), test/spot-struggle-duration.test.ts (DYN-8), and
// test/spot-struggle-group.test.ts (DYN-14) while writing the third one made the duplication obvious;
// see those files for concrete usage of everything below.
import { RaceSolver } from '../RaceSolver';
import { Rule30CARng } from '../Random';

// Some RaceSolver methods call sibling methods on `this` (e.g. updateRushedState() calls
// this.endRushedState(); updateLeadCompetition() calls this.updateLeadCompetitionExit()). A
// plain stub object doesn't have those on its prototype chain, so
// RaceSolver.prototype.<method>.call(stub) throws "not a function" the moment execution reaches
// the inner call -- not at stub construction, which makes it an easy thing to forget until a
// test actually exercises that code path (this bit test/spot-struggle-duration.test.ts's stub when
// DYN-14 turned updateLeadCompetition() from one method into a dispatcher). attachMethods copies
// the named real implementations onto the stub so those calls resolve, and centralizes the
// RaceSolver.prototype lookup instead of repeating `foo: RaceSolver.prototype.foo` per stub.
export function attachMethods<T extends object, K extends keyof RaceSolver>(stub: T, ...methodNames: K[]): T & Pick<RaceSolver, K> {
	const out = stub as any;
	for (const name of methodNames) {
		out[name] = (RaceSolver.prototype as any)[name];
	}
	return out as T & Pick<RaceSolver, K>;
}

// Wires every uma's `umas` field to the same shared array, including herself -- matching
// initUmas()'s real shape (RaceSolver.ts: `this.umas = [...otherUmas.filter(u => u != null),
// this]`). Any method that reads `this.umas` to see other umas (lead competition, position keep,
// dueling, first-uma-in-late-race, ...) needs this for a multi-uma stub test.
export function field<T extends {umas: unknown[]}>(...umas: T[]): T[] {
	umas.forEach(u => { u.umas = umas; });
	return umas;
}

// Steps a stubbed RaceSolver method the way RaceSolver.step() drives the real thing: advance a
// timer field by dt, then call the method, repeating until `isActive(stub)` goes false or
// `maxTime` is hit (a safety cap against a misconfigured stub looping forever, not a real race
// duration). Returns the elapsed time, always in [true duration, true duration + dt). Callers
// that need an initial "entry" call before the loop starts (e.g. Rushed's first-tick check) make
// that call themselves first -- entry logic is mechanic-specific, only the step-and-check loop
// shape is shared.
export function stepUntilInactive<T>(
	stub: T,
	method: (this: T) => void,
	timerOf: (stub: T) => {t: number},
	isActive: (stub: T) => boolean,
	dt: number,
	maxTime = 60,
): number {
	let t = 0;
	while (isActive(stub) && t < maxTime) {
		t += dt;
		timerOf(stub).t += dt;
		method.call(stub);
	}
	return t;
}

// Derives a fresh sub-stream seed from a master seed the way production code does
// (`new Rule30CARng(this.rng.int32())`, see e.g. RaceSolver.ts's construction of per-mechanic
// RNGs) rather than feeding sequential integers directly to a per-sample PRNG -- prando's first
// draw is correlated with a small integer seed, which biases exactly the kind of single-roll
// measurement these tests make across many samples. Originally a comment in
// test/rushed-escape-roll.test.ts's histogram(); pulled out so a future stochastic mechanics test
// gets correct seeding by using this rather than by copying the comment and hoping to remember why.
export function seededSubStream(masterSeed: number): () => number {
	const master = new Rule30CARng(masterSeed);
	return () => master.int32();
}
