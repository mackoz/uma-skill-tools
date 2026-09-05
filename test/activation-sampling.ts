import test from 'tape';
import { DistributionRandomPolicy, ErlangRandomPolicy, LogNormalRandomPolicy } from '../ActivationSamplePolicy';
import { Region, RegionList } from '../Region';
import { deriveSeed, PRNG, Rule30CARng } from '../Random';
import courses from '../data/jp/course_data.json';

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

// SKL-29 regression. DistributionRandomPolicy.sample() maps a distribution draw -- an offset into
// the allowed regions laid end to end -- back onto a real course position by walking the region
// list. clampToCourseRange() caps a draw at `courseRange * (1 - Number.EPSILON)`, nominally one ulp
// below the total; but sample() re-accumulates that total in a different order than the `range`
// reduce did (`pos += start; pos -= end`, two roundings per region, vs `acc + r.end - r.start`).
// For some region layouts the two float sums disagree by >=1 ulp, the remainder at the last region
// exceeds its length, and the unbounded loop indexed rs[rs.length] -- TypeError reading 'start'.
// Any draw past the distribution's 99.9% quantile saturates the cap, so this was reachable in
// normal use (~1 in 50k draws), not just synthetically.

function regionList(bounds: [number, number][]) {
	const rs = new RegionList();
	bounds.forEach(([start, end]) => rs.push(new Region(start, end)));
	return rs;
}

// course 10104's straights: three regions whose lengths, re-summed in walk order, fall one ulp short
// of `range`, so the cap `range * (1 - Number.EPSILON)` cannot be consumed by the walk.
const OVERRUN_LAYOUT: [number, number][] = [[333.3333333333333, 375], [925, 1200], [1734, 2000]];

test('an Erlang draw past its upper quantile stays inside the last region', t => {
	// End-to-end through a real policy: near_count's ErlangRandomPolicy(2, 2) (skill 910191). Its
	// variate is -log(u)/lambda over a product of k uniforms, so a near-zero uniform stream drives
	// it past the 99.9% quantile and saturates clampToCourseRange's upper bound. Erlang draws no
	// rejection samples, so a constant stream is safe here (it is NOT for LogNormalRandomPolicy,
	// whose Box-Muller loop would never terminate).
	const saturatingRng = Object.freeze({int32: () => 0, random: () => 1e-300, uniform: (_upper: number) => 0});
	const regions = regionList(OVERRUN_LAYOUT);

	const samples = new ErlangRandomPolicy(2.0, 2.0).sample(regions, 1, saturatingRng);

	const last = regions[regions.length - 1];
	t.equal(samples.length, 1, 'returns exactly one sample');
	t.ok(samples[0].start >= last.start && samples[0].start <= last.end,
		'the saturated sample lands inside the last region');
	t.equal(samples[0].end, last.end, 'the sample window ends at the containing region');
	t.end();
});

// Drives sample()'s region walk directly at its boundary, without routing through a real
// distribution's RNG: what matters to the walk is only the offset it is handed.
class FixedOffsetPolicy extends DistributionRandomPolicy {
	constructor(readonly offsetOf: (range: number) => number) { super(); }

	distribution(upper: number, nsamples: number, _rng: PRNG) {
		return Array.from({length: nsamples}, () => this.offsetOf(upper));
	}
}

const NO_RNG = Object.freeze({
	int32: () => { throw new Error('unused'); },
	random: () => { throw new Error('unused'); },
	uniform: (_upper: number) => { throw new Error('unused'); }
});

test('the region walk never indexes past the last region, whatever offset it is handed', t => {
	// every offset clampToCourseRange can emit, plus the out-of-contract ones the walk must still
	// survive rather than throw on
	const offsets: [string, (range: number) => number][] = [
		['the exact cap', range => range * (1 - Number.EPSILON)],
		['the full range', range => range],
		['one ulp over', range => range + Math.max(range, 1) * Number.EPSILON],
		['zero', _ => 0]
	];

	const layouts: [number, number][][] = [OVERRUN_LAYOUT];
	Object.keys(courses).forEach(courseId => {
		const course = (courses as any)[courseId];
		const bases: [number, number][][] = [
			(course.corners || []).map((c: any) => [c.start, c.start + c.length] as [number, number]),
			(course.straights || []).map((s: any) => [s.start, s.end] as [number, number])
		];
		// the phase/section windows real activation conditions intersect these with
		const windows = [[0, course.distance], [course.distance / 6, course.distance * 2 / 3],
			[course.distance / 3, course.distance * 2 / 3], [course.distance * 2 / 3, course.distance]];
		bases.forEach(base => windows.forEach(([ws, we]) => {
			const clipped = base
				.map(([s, e]) => [Math.max(s, ws), Math.min(e, we)] as [number, number])
				.filter(([s, e]) => e > s)
				.sort((a, b) => a[0] - b[0]);
			if (clipped.length > 0) layouts.push(clipped);
		}));
	});
	t.ok(layouts.length > 100, `the sweep covers a non-trivial number of real course layouts (${layouts.length})`);

	const failures: string[] = [];
	const escaped: string[] = [];
	layouts.forEach(bounds => offsets.forEach(([label, offsetOf]) => {
		const regions = regionList(bounds);
		const last = regions[regions.length - 1];
		let samples;
		try {
			samples = new FixedOffsetPolicy(offsetOf).sample(regions, 2, NO_RNG);
		} catch (e) {
			failures.push(`${label} ${JSON.stringify(bounds)}: ${(e as Error).message}`);
			return;
		}
		samples.forEach(sample => {
			const within = regions.some(r => sample.start >= r.start && sample.start <= r.end && sample.end === r.end);
			if (!within) escaped.push(`${label} ${JSON.stringify(bounds)}: got [${sample.start},${sample.end})`);
		});
		if (samples.some(sample => sample.end > last.end)) {
			escaped.push(`${label} ${JSON.stringify(bounds)}: sample window past the last region`);
		}
	}));

	t.deepEqual(failures.slice(0, 3), [], `no layout/offset throws (${failures.length} of ${layouts.length * offsets.length} did)`);
	t.deepEqual(escaped.slice(0, 3), [], `every sample lands inside one of its own regions (${escaped.length} did not)`);
	t.end();
});

test('interior offsets are unaffected by the bounds fix', t => {
	// the walk is correct for every offset that is not at the boundary, and must stay so: a sample
	// at offset x sits x metres into the regions laid end to end.
	const regions = regionList(OVERRUN_LAYOUT);
	const lengths = OVERRUN_LAYOUT.map(([s, e]) => e - s);
	const range = lengths.reduce((a, b) => a + b, 0);

	const mismatches: string[] = [];
	for (let step = 0; step < 500; ++step) {
		const offset = range * (step / 500);
		let remaining = offset, expected = -1;
		for (let j = 0; j < lengths.length; ++j) {
			if (remaining <= lengths[j]) { expected = OVERRUN_LAYOUT[j][0] + remaining; break; }
			remaining -= lengths[j];
		}
		const got = new FixedOffsetPolicy(_ => offset).sample(regions, 1, NO_RNG)[0].start;
		if (Math.abs(got - expected) > 1e-9) mismatches.push(`offset ${offset}: expected ${expected}, got ${got}`);
	}

	t.deepEqual(mismatches.slice(0, 3), [], `all 500 interior offsets map to the same position as before (${mismatches.length} did not)`);
	t.end();
});
