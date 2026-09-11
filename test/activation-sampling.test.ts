import { test } from 'vitest';
import { strictEqual, notStrictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { DistributionRandomPolicy, ErlangRandomPolicy, LogNormalRandomPolicy, RandomPolicy, StraightRandomPolicy, AllCornerRandomPolicy, createFixedPositionPolicy } from '../ActivationSamplePolicy';
import { Region, RegionList } from '../Region';
import { deriveSeed, PRNG, Rule30CARng } from '../Random';
import courses from '../data/jp/course_data.json';

const RANGE = 2400;

function withinRange(values: number[]): boolean {
	return values.every(value => Number.isFinite(value) && value >= 0 && value < RANGE);
}

test('lognormal samples have fixed bounds and prefix stability', () => {
	const policy = new LogNormalRandomPolicy(0, 1);
	const one = policy.distribution(RANGE, 1, new Rule30CARng(12345));
	const many = policy.distribution(RANGE, 101, new Rule30CARng(12345));
	strictEqual(one.length, 1, 'returns exactly one sample');
	strictEqual(many.length, 101, 'returns exactly the requested sample count');
	strictEqual(one[0], many[0], 'the first sample does not depend on requested count');
	ok(withinRange(many), 'all samples remain within the course range');
	ok(new Set(many.map(Math.round)).size > 20, 'samples retain a non-degenerate shape');
});

test('Erlang samples have exact quantile bounds and prefix stability', () => {
	const policy = new ErlangRandomPolicy(3, 0.5);
	const one = policy.distribution(RANGE, 1, new Rule30CARng(54321));
	const many = policy.distribution(RANGE, 101, new Rule30CARng(54321));
	strictEqual(one.length, 1, 'returns exactly one sample');
	strictEqual(many.length, 101, 'returns exactly the requested sample count');
	strictEqual(one[0], many[0], 'the first sample does not depend on requested count');
	ok(withinRange(many), 'all samples remain within the course range');
	ok(new Set(many.map(Math.round)).size > 20, 'samples retain a non-degenerate shape');
});

test('derived skill streams are stable and isolated', () => {
	const base = 8675309;
	const skillA = new Rule30CARng(deriveSeed(base, '100001:0:0'));
	const first = Array.from({length: 5}, () => skillA.random());
	const unrelated = new Rule30CARng(deriveSeed(base, '200002:0:0'));
	Array.from({length: 20}, () => unrelated.random());
	const skillAAgain = new Rule30CARng(deriveSeed(base, '100001:0:0'));
	deepStrictEqual(first, Array.from({length: 5}, () => skillAAgain.random()), 'other skill streams cannot shift this skill');
	notStrictEqual(deriveSeed(base, '100001:0:0'), deriveSeed(base, '200002:0:0'), 'different keys derive different seeds');
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

test('an Erlang draw past its upper quantile stays inside the last region', () => {
	// End-to-end through a real policy: near_count's ErlangRandomPolicy(2, 2) (skill 910191). Its
	// variate is -log(u)/lambda over a product of k uniforms, so a near-zero uniform stream drives
	// it past the 99.9% quantile and saturates clampToCourseRange's upper bound. Erlang draws no
	// rejection samples, so a constant stream is safe here (it is NOT for LogNormalRandomPolicy,
	// whose Box-Muller loop would never terminate).
	const saturatingRng = Object.freeze({int32: () => 0, random: () => 1e-300, uniform: (_upper: number) => 0});
	const regions = regionList(OVERRUN_LAYOUT);

	const samples = new ErlangRandomPolicy(2.0, 2.0).sample(regions, 1, saturatingRng);

	const last = regions[regions.length - 1];
	strictEqual(samples.length, 1, 'returns exactly one sample');
	ok(samples[0].start >= last.start && samples[0].start <= last.end,
		'the saturated sample lands inside the last region');
	strictEqual(samples[0].end, last.end, 'the sample window ends at the containing region');
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

test('the region walk never indexes past the last region, whatever offset it is handed', () => {
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
	ok(layouts.length > 100, `the sweep covers a non-trivial number of real course layouts (${layouts.length})`);

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

	deepStrictEqual(failures.slice(0, 3), [], `no layout/offset throws (${failures.length} of ${layouts.length * offsets.length} did)`);
	deepStrictEqual(escaped.slice(0, 3), [], `every sample lands inside one of its own regions (${escaped.length} did not)`);
});

test('interior offsets are unaffected by the bounds fix', () => {
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

	deepStrictEqual(mismatches.slice(0, 3), [], `all 500 interior offsets map to the same position as before (${mismatches.length} did not)`);
});

// SKL-21: sample() gained a `spares` argument so cooldown skills can be handed more than one
// candidate trigger. The contract that matters most is the *absence* of change: at spares=0 every
// policy must draw exactly the RNG values it drew before, in the same order, so that skills
// without a cooldown produce bit-identical races. GOLDEN was captured by running the pre-SKL-21
// implementations -- see the plan's Task 2 Step 1 for the exact command.

const SPARE_REGIONS = (() => {
	const rl = new RegionList();
	([[300, 600], [900, 1100], [1500, 1800], [2000, 2150]] as [number, number][])
		.forEach(([a, b]) => rl.push(new Region(a, b)));
	return rl;
})();

const GOLDEN: Record<string, [number, number][]> = {
	RandomPolicy: [[1531,1541],[1783,1793],[2105,2115],[474,484],[982,992]],
	StraightRandomPolicy: [[1531,1541],[1783,1793],[2105,2115],[1014,1024],[982,992]],
	AllCornerRandomPolicy: [[1531,1541],[2105,2115],[319,329],[2067,2077],[482,492]],
};

const SPARE_POLICIES: [string, any][] = [
	['RandomPolicy', RandomPolicy],
	['StraightRandomPolicy', StraightRandomPolicy],
	['AllCornerRandomPolicy', AllCornerRandomPolicy]
];

for (const [name, policy] of SPARE_POLICIES) {
	test(`${name}: spares=0 reproduces the pre-SKL-21 output exactly`, () => {
		const out = policy.sample(SPARE_REGIONS, 5, new Rule30CARng(20260910));
		deepStrictEqual(out.map((r: Region) => [r.start, r.end]), GOLDEN[name]);
	});

	test(`${name}: omitting spares is the same as passing 0`, () => {
		const implicit = policy.sample(SPARE_REGIONS, 5, new Rule30CARng(20260910));
		const explicit = policy.sample(SPARE_REGIONS, 5, new Rule30CARng(20260910), 0);
		deepStrictEqual(
			implicit.map((r: Region) => [r.start, r.end]),
			explicit.map((r: Region) => [r.start, r.end])
		);
	});

	test(`${name}: spares=2 keeps every primary identical and adds a fixed-stride tail`, () => {
		const base = policy.sample(SPARE_REGIONS, 5, new Rule30CARng(20260910));
		const withSpares = policy.sample(SPARE_REGIONS, 5, new Rule30CARng(20260910), 2);
		strictEqual(withSpares.length, 5 * 3, 'nsamples * (1 + spares) regions returned');
		deepStrictEqual(
			withSpares.slice(0, 5).map((r: Region) => [r.start, r.end]),
			base.map((r: Region) => [r.start, r.end]),
			'the primaries are untouched by asking for spares'
		);
	});

	test(`${name}: each sample's spares strictly follow its primary`, () => {
		const out = policy.sample(SPARE_REGIONS, 5, new Rule30CARng(20260910), 2);
		for (let i = 0; i < 5; ++i) {
			let prev = out[i].start;
			for (let j = 0; j < 2; ++j) {
				const spare = out[5 + i * 2 + j];
				if (spare.end - spare.start === 0) continue;  // padding for "no spare available"
				ok(spare.start > prev, `sample ${i} spare ${j} at ${spare.start} follows ${prev}`);
				prev = spare.start;
			}
		}
	});
}

// SKL-21: the distribution policies get spares too -- 30 of the 58 cooldown skills use them, and
// they are the only family the replay corpus has ever caught re-triggering. Their primaries must
// stay identical because distribution() is prefix-stable (pinned by the tests above), so drawing a
// longer batch cannot disturb the first nsamples values.
test('ErlangRandomPolicy: spares=2 preserves primaries and orders spares after them', () => {
	const policy = new ErlangRandomPolicy(3, 2.0);
	const base = policy.sample(SPARE_REGIONS, 4, new Rule30CARng(777));
	const withSpares = policy.sample(SPARE_REGIONS, 4, new Rule30CARng(777), 2);
	strictEqual(withSpares.length, 4 * 3);
	deepStrictEqual(
		withSpares.slice(0, 4).map(r => [r.start, r.end]),
		base.map(r => [r.start, r.end]),
		'primaries unchanged by requesting spares'
	);
	for (let i = 0; i < 4; ++i) {
		let prev = withSpares[i].start;
		for (let j = 0; j < 2; ++j) {
			const spare = withSpares[4 + i * 2 + j];
			if (spare.end - spare.start === 0) continue;
			ok(spare.start > prev, `sample ${i} spare ${j} follows the previous point`);
			prev = spare.start;
		}
	}
});

test('ErlangRandomPolicy: spares=0 is unchanged from omitting it', () => {
	const policy = new ErlangRandomPolicy(3, 2.0);
	const implicit = policy.sample(SPARE_REGIONS, 4, new Rule30CARng(4242));
	const explicit = policy.sample(SPARE_REGIONS, 4, new Rule30CARng(4242), 0);
	deepStrictEqual(
		implicit.map(r => [r.start, r.end]),
		explicit.map(r => [r.start, r.end])
	);
});

// SKL-21 fix-report finding: createFixedPositionPolicy is used only by tools/replay/replayDiff.ts
// via addSkillAtPosition's _samplePolicyOverride, but that path is exactly what Task 6 builds on,
// and the replay corpus is dense with cooldown-bearing skills. It must satisfy the
// nsamples * (1 + spares) layout contract or build()'s `n = flat.length / (1 + spares)` goes
// fractional and the indexing breaks. A pinned position means "fire exactly here" and must never
// re-arm, so every spare is a zero-length region -- permanently inert, since a zero-length region
// can never satisfy `pos >= trigger.start && pos < trigger.end`.
test('createFixedPositionPolicy: spares=2 returns nsamples * (1 + spares) regions, all-inert spares', () => {
	const policy = createFixedPositionPolicy(1234);
	const nsamples = 5;
	const spares = 2;
	const out = policy.sample(SPARE_REGIONS, nsamples, new Rule30CARng(20260910), spares);
	strictEqual(out.length, nsamples * (1 + spares), 'nsamples * (1 + spares) regions returned');

	const primaries = out.slice(0, nsamples);
	ok(primaries.every(r => r.start === 1234 && r.end === 1244), 'every primary is pinned at the fixed position');

	for (let i = 0; i < nsamples; ++i) {
		for (let j = 0; j < spares; ++j) {
			const spare = out[nsamples + i * spares + j];
			strictEqual(spare.end - spare.start, 0, `sample ${i} spare ${j} is zero-length`);
		}
	}
});

test('createFixedPositionPolicy: spares=0 is unchanged from omitting it', () => {
	const policy = createFixedPositionPolicy(1234);
	const implicit = policy.sample(SPARE_REGIONS, 5, new Rule30CARng(20260910));
	const explicit = policy.sample(SPARE_REGIONS, 5, new Rule30CARng(20260910), 0);
	deepStrictEqual(
		implicit.map((r: Region) => [r.start, r.end]),
		explicit.map((r: Region) => [r.start, r.end])
	);
});
