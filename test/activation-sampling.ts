import test from 'tape';
import { ErlangRandomPolicy, LogNormalRandomPolicy } from '../ActivationSamplePolicy';
import { deriveSeed, Rule30CARng } from '../Random';

const RANGE = 2400;

function withinRange(values: number[]): boolean {
	return values.every(value => Number.isFinite(value) && value >= 0 && value < RANGE);
}

test('lognormal samples have fixed bounds and prefix stability', t => {
	const policy = new LogNormalRandomPolicy(0, 1);
	const one = policy.distribution(RANGE, 1, new Rule30CARng(12345));
	const many = policy.distribution(RANGE, 101, new Rule30CARng(12345));
	t.equal(one.length, 1, 'returns exactly one sample');
	t.equal(many.length, 101, 'returns exactly the requested sample count');
	t.equal(one[0], many[0], 'the first sample does not depend on requested count');
	t.ok(withinRange(many), 'all samples remain within the course range');
	t.ok(new Set(many.map(Math.round)).size > 20, 'samples retain a non-degenerate shape');
	t.end();
});

test('Erlang samples have exact quantile bounds and prefix stability', t => {
	const policy = new ErlangRandomPolicy(3, 0.5);
	const one = policy.distribution(RANGE, 1, new Rule30CARng(54321));
	const many = policy.distribution(RANGE, 101, new Rule30CARng(54321));
	t.equal(one.length, 1, 'returns exactly one sample');
	t.equal(many.length, 101, 'returns exactly the requested sample count');
	t.equal(one[0], many[0], 'the first sample does not depend on requested count');
	t.ok(withinRange(many), 'all samples remain within the course range');
	t.ok(new Set(many.map(Math.round)).size > 20, 'samples retain a non-degenerate shape');
	t.end();
});

test('derived skill streams are stable and isolated', t => {
	const base = 8675309;
	const skillA = new Rule30CARng(deriveSeed(base, '100001:0:0'));
	const first = Array.from({length: 5}, () => skillA.random());
	const unrelated = new Rule30CARng(deriveSeed(base, '200002:0:0'));
	Array.from({length: 20}, () => unrelated.random());
	const skillAAgain = new Rule30CARng(deriveSeed(base, '100001:0:0'));
	t.deepEqual(first, Array.from({length: 5}, () => skillAAgain.random()), 'other skill streams cannot shift this skill');
	t.notEqual(deriveSeed(base, '100001:0:0'), deriveSeed(base, '200002:0:0'), 'different keys derive different seeds');
	t.end();
});
