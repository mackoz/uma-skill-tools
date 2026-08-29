import { Region, RegionList } from './Region';
import { PRNG } from './Random';

export interface ActivationSamplePolicy {
	sample(regions: RegionList, nsamples: number, rng: PRNG): Region[]

	// essentially, when two conditions are combined with an AndOperator one should take precedence over the other
	// immediate transitions into anything and straight_random/all_corner_random dominate everything except each other
	// NB. currently there are no skills that combine straight_random or all_corner_random with anything other than
	// immediate conditions (running_style or distance_type), and obviously they are mutually exclusive with each other
	// the actual x_random (phase_random, down_slope_random, etc) ones should dominate the ones that are not actually
	// random but merely modeled with a probability distribution
	// use smalltalk-style double dispatch to implement the transitions
	reconcile(other: ActivationSamplePolicy): ActivationSamplePolicy
	reconcileImmediate(other: ActivationSamplePolicy): ActivationSamplePolicy
	reconcileDistributionRandom(other: ActivationSamplePolicy): ActivationSamplePolicy
	reconcileRandom(other: ActivationSamplePolicy): ActivationSamplePolicy
	reconcileStraightRandom(other: ActivationSamplePolicy): ActivationSamplePolicy
	reconcileAllCornerRandom(other: ActivationSamplePolicy): ActivationSamplePolicy
}

export const ImmediatePolicy = Object.freeze({
	sample(regions: RegionList, _0: number, _1: PRNG) { return regions.slice(0,1); },
	reconcile(other: ActivationSamplePolicy) { return other.reconcileImmediate(this); },
	reconcileImmediate(other: ActivationSamplePolicy) { return other; },
	reconcileDistributionRandom(other: ActivationSamplePolicy) { return other; },
	reconcileRandom(other: ActivationSamplePolicy) { return other; },
	reconcileStraightRandom(other: ActivationSamplePolicy) { return other; },
	reconcileAllCornerRandom(other: ActivationSamplePolicy) { return other; }
});

export const RandomPolicy = Object.freeze({
	sample(regions: RegionList, nsamples: number, rng: PRNG) {
		if (regions.length == 0) {
			return [];
		}
		let acc = 0;
		const weights = regions.map(r => acc += r.end - r.start);
		const samples = [];
		for (let i = 0; i < nsamples; ++i) {
			const threshold = rng.uniform(acc);
			const region = regions.find((_,i) => weights[i] > threshold)!;
			samples.push(region.start + rng.uniform(region.end - region.start - 10));
		}
		return samples.map(pos => new Region(pos, pos + 10));
	},
	reconcile(other: ActivationSamplePolicy) { return other.reconcileRandom(this); },
	reconcileImmediate(_: ActivationSamplePolicy) { return this; },
	reconcileDistributionRandom(other: ActivationSamplePolicy) { return this; },
	reconcileRandom(other: ActivationSamplePolicy) { return other; },
	reconcileStraightRandom(other: ActivationSamplePolicy) { return other; },
	reconcileAllCornerRandom(other: ActivationSamplePolicy) { return other; }
});

export abstract class DistributionRandomPolicy {
	abstract distribution(upper: number, nsamples: number, rng: PRNG): number[]

	sample(regions: RegionList, nsamples: number, rng: PRNG) {
		if (regions.length == 0) {
			return [];
		}
		const range = regions.reduce((acc,r) => acc + r.end - r.start, 0);
		const rs = regions.slice().sort((a,b) => a.start - b.start);
		const randoms = this.distribution(range, nsamples, rng);
		const samples = [];
		for (let i = 0; i < nsamples; ++i) {
			let pos = randoms[i];
			for (let j = 0;; j++) {
				pos += rs[j].start;
				if (pos > rs[j].end) {
					pos -= rs[j].end;
				} else {
					samples.push(new Region(pos, rs[j].end));
					break;
				}
			}
		}
		return samples;
	}

	reconcile(other: ActivationSamplePolicy) { return other.reconcileDistributionRandom(this); }
	reconcileImmediate(_: ActivationSamplePolicy) { return this; }
	// ANCHOR: distribution-random-poisson-todo
	reconcileDistributionRandom(other: ActivationSamplePolicy) {
		// this is, strictly speaking, probably not the right thing to do
		// probably this should be the joint probability distribution of `this` and `other`, but that is too complex to implement
		// TODO this is something of a stopgap measure anyway, since eventually we'd like to model most of the conditions that use
		// DistributionRandomPolicy with dynamic conditions using a Poisson process or something, which would make this obsolete
		// (this would also enable other features like cooldowns for distribution-random skills).
		return this;
	}
	// this is probably not exactly the right thing to do either, but the true random conditions do need to place a fixed trigger
	// statically ahead of time, uninfluenced by us. this means that the only alternatives are 1) this condition is coincidentally
	// fulfilled during the static random trigger or 2) the skill does not activate at all.
	// since the latter is not particularly interesting, it's safe to just ignore this sample policy and use only the true random one.
	reconcileRandom(other: ActivationSamplePolicy) { return other; }
	reconcileStraightRandom(other: ActivationSamplePolicy) { return other; }
	reconcileAllCornerRandom(other: ActivationSamplePolicy) { return other; }
}

const CENTRAL_LOWER_QUANTILE = 0.001;
const CENTRAL_UPPER_QUANTILE = 0.999;

function clampToCourseRange(value: number, lower: number, upper: number, courseRange: number): number {
	if (!(upper > lower) || courseRange <= 0) {
		return 0;
	}
	const normalized = Math.max(0, Math.min(1, (value - lower) / (upper - lower)));
	return Math.min(courseRange * (1 - Number.EPSILON), courseRange * normalized);
}

// Acklam's inverse-normal approximation. Accuracy is ample for fixed 0.1%/99.9% bounds.
function inverseStandardNormal(p: number): number {
	const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
	const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
	const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
	const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
	const threshold = 0.02425;
	if (p < threshold) {
		const q = Math.sqrt(-2 * Math.log(p));
		return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
			((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
	}
	if (p > 1 - threshold) {
		return -inverseStandardNormal(1 - p);
	}
	const q = p - 0.5;
	const r = q * q;
	return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
		(((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const erlangBounds = new Map<string, [number, number]>();

function erlangCdf(x: number, k: number, lambda: number): number {
	const lx = lambda * x;
	let term = 1;
	let sum = 1;
	for (let i = 1; i < k; ++i) {
		term *= lx / i;
		sum += term;
	}
	return 1 - Math.exp(-lx) * sum;
}

function erlangQuantile(p: number, k: number, lambda: number): number {
	let lower = 0;
	let upper = Math.max(1 / lambda, k / lambda);
	while (erlangCdf(upper, k, lambda) < p) {
		upper *= 2;
	}
	for (let i = 0; i < 80; ++i) {
		const middle = (lower + upper) / 2;
		if (erlangCdf(middle, k, lambda) < p) lower = middle;
		else upper = middle;
	}
	return (lower + upper) / 2;
}

export class UniformRandomPolicy extends DistributionRandomPolicy {
	constructor() { super(); }

	distribution(upper: number, nsamples: number, rng: PRNG) {
		const nums = [];
		for (let i = 0; i < nsamples; ++i) {
			nums.push(rng.uniform(upper));
		}
		return nums;
	}
}

export class LogNormalRandomPolicy extends DistributionRandomPolicy {
	constructor(readonly mu: number, readonly sigma: number) { super(); }

	distribution(upper: number, nsamples: number, rng: PRNG) {
		// see <https://en.wikipedia.org/wiki/Box%E2%80%93Muller_transform>
		const nums = [];
		const halfn = Math.ceil(nsamples / 2);
		for (let i = 0; i < halfn; ++i) {
			let x, y, r2;
			do {
				x = rng.random() * 2.0 - 1.0;
				y = rng.random() * 2.0 - 1.0;
				r2 = x * x + y * y;
			} while (r2 == 0.0 || r2 >= 1.0);
			const m = Math.sqrt(-2.0 * Math.log(r2) / r2) * this.sigma;
			const a = Math.exp(x * m + this.mu);
			const b = Math.exp(y * m + this.mu);
			nums.push(a,b);
		}
		const lower = Math.exp(this.mu + this.sigma * inverseStandardNormal(CENTRAL_LOWER_QUANTILE));
		const high = Math.exp(this.mu + this.sigma * inverseStandardNormal(CENTRAL_UPPER_QUANTILE));
		return nums.slice(0, nsamples).map(n => clampToCourseRange(n, lower, high, upper));
	}
}

export class ErlangRandomPolicy extends DistributionRandomPolicy {
	constructor(readonly k: number, readonly lambda: number) { super(); }

	distribution(upper: number, nsamples: number, rng: PRNG) {
		const nums = [];
		for (let i = 0; i < nsamples; ++i) {
			let u = 1.0;
			for (let j = 0; j < this.k; ++j) {
				u *= rng.random();
			}
			const n = -Math.log(u) / this.lambda;
			nums.push(n);
		}
		const cacheKey = `${this.k}:${this.lambda}`;
		let bounds = erlangBounds.get(cacheKey);
		if (bounds == null) {
			bounds = [
				erlangQuantile(CENTRAL_LOWER_QUANTILE, this.k, this.lambda),
				erlangQuantile(CENTRAL_UPPER_QUANTILE, this.k, this.lambda)
			];
			erlangBounds.set(cacheKey, bounds);
		}
		return nums.map(n => clampToCourseRange(n, bounds[0], bounds[1], upper));
	}
}

export const StraightRandomPolicy = Object.freeze({
	sample(regions: RegionList, nsamples: number, rng: PRNG) {
		// regular RandomPolicy weights regions by their length, so any given point has an equal chance to be chosen across all regions
		// StraightRandomPolicy first picks a region with equal chance regardless of length, and then picks a random point on that region
		if (regions.length == 0) {
			return [];
		}
		const samples = [];
		for (let i = 0; i < nsamples; ++i) {
			const r = regions[rng.uniform(regions.length)];
			samples.push(r.start + rng.uniform(r.end - r.start - 10));
		}
		return samples.map(pos => new Region(pos, pos + 10));
	},
	reconcile(other: ActivationSamplePolicy) { return other.reconcileStraightRandom(this); },
	reconcileImmediate(_: ActivationSamplePolicy) { return this; },
	reconcileDistributionRandom(_: ActivationSamplePolicy) { return this; },
	reconcileRandom(_: ActivationSamplePolicy) { return this; },
	reconcileStraightRandom(other: ActivationSamplePolicy) { return other; },
	reconcileAllCornerRandom(other: ActivationSamplePolicy) { throw new Error('cannot reconcile StraightRandomPolicy with AllCornerRandomPolicy'); }
});

export const AllCornerRandomPolicy = Object.freeze({
	placeTriggers(regions: RegionList, rng: PRNG) {
		const triggers = [];
		const candidates = regions.slice();
		candidates.sort((a,b) => a.start - b.start);
		while (triggers.length < 4 && candidates.length > 0) {
			const ci = rng.uniform(candidates.length);
			const c = candidates[ci];
			const start = c.start + rng.uniform(c.end - c.start - 10);
			// note that as each corner's end cannot come after the start of the next corner, this maintains that the candidates
			// are sorted by start
			if (start + 20 <= c.end) {
				candidates.splice(ci, 1, new Region(start + 10, c.end));
			} else {
				candidates.splice(ci, 1);
			}
			candidates.splice(0, ci);  // everything before this corner in the array is guaranteed to be before it in distance
			triggers.push(start);
		}
		// TODO support multiple triggers for skills with cooldown
		return new Region(triggers[0], triggers[0] + 10);  // guaranteed to be the earliest trigger since each trigger is placed after the last one
	},
	sample(regions: RegionList, nsamples: number, rng: PRNG) {
		const samples = [];
		for (let i = 0; i < nsamples; ++i) {
			samples.push(this.placeTriggers(regions, rng));
		}
		return samples;
	},
	reconcile(other: ActivationSamplePolicy) { return other.reconcileAllCornerRandom(this); },
	reconcileImmediate(_: ActivationSamplePolicy) { return this; },
	reconcileDistributionRandom(_: ActivationSamplePolicy) { return this; },
	reconcileRandom(_: ActivationSamplePolicy) { return this; },
	reconcileStraightRandom(_: ActivationSamplePolicy) { throw new Error('cannot reconcile StraightRandomPolicy with AllCornerRandomPolicy'); },
	reconcileAllCornerRandom(_: ActivationSamplePolicy) { return this; }
});

/**
 * Creates a fixed position sample policy that forces a skill to activate at a specific distance.
 * This ignores the skill's normal activation conditions and places the trigger at the exact position specified.
 * @param position The distance (in meters) where the skill should activate
 * @returns An ActivationSamplePolicy that always triggers at the specified position
 */
export function createFixedPositionPolicy(position: number): ActivationSamplePolicy {
	return Object.freeze({
		sample(_regions: RegionList, nsamples: number, _rng: PRNG) {
			// Always return the same fixed position for all samples
			const samples = [];
			for (let i = 0; i < nsamples; ++i) {
				samples.push(new Region(position, position + 10));
			}
			return samples;
		},
		reconcile(_other: ActivationSamplePolicy) { return this; },
		reconcileImmediate(_: ActivationSamplePolicy) { return this; },
		reconcileDistributionRandom(_: ActivationSamplePolicy) { return this; },
		reconcileRandom(_: ActivationSamplePolicy) { return this; },
		reconcileStraightRandom(_: ActivationSamplePolicy) { return this; },
		reconcileAllCornerRandom(_: ActivationSamplePolicy) { return this; }
	});
}
