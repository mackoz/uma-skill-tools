// HP-6: a "Multiply Random" effect (ability_value_usage 8 or 9 -- the game docs treat them as
// identical) rolls its own value-scaling multiplier per activation: 60% -> 0.0x, 30% -> 0.02x,
// 10% -> 0.04x (game-mechanics/skills.md:182-188). A previous fix applied a flat 0.04x to every
// effect on skills 202031/202032/104901111 regardless of ability_value_usage, crushing their
// ability_value_usage=1 ("Direct", no scaling) TargetSpeed effect to 1/25th alongside the Recovery
// effect that actually needed scaling. This pins scaleEffectValue(): the roll itself, its
// determinism/independence properties, and that valueUsage 1/undefined pass straight through.
//
// scaleEffectValue() only reads this.skillValueSeed and this.skillActivationCounts plus the
// PendingSkill/SkillEffect arguments passed in -- it doesn't call any sibling method on `this` --
// so the stub carries just those two fields, same minimal-stub spirit as
// test/rushed-escape-roll.ts's makeRushedStub.
import test from 'tape';
import { RaceSolver, Perspective, SkillType, PendingSkill, SkillEffect } from '../RaceSolver';
import { attachMethods, seededSubStream } from './RaceSolverTestHelpers';

function makeStub(skillValueSeed: number) {
	return attachMethods({
		skillValueSeed,
		skillActivationCounts: new Map<string, number>(),
	}, 'scaleEffectValue');
}

function pendingSkill(skillId: string, perspective: Perspective = Perspective.Self): PendingSkill {
	return {skillId, perspective} as PendingSkill;
}

function effect(valueUsage: number | undefined, modifier = 1): SkillEffect {
	return {type: SkillType.Recovery, baseDuration: 0, modifier, valueUsage};
}

// Draws once against a fresh stub, manually seeding skillActivationCounts so the read inside
// scaleEffectValue() sees exactly `activationCount` -- mirrors how activateSkill() will have
// already incremented the map by the time scaleEffectValue() reads it for a given activation.
function draw(skillValueSeed: number, skillId: string, effectIdx: number, activationCount: number, perspective: Perspective = Perspective.Self): number {
	const stub = makeStub(skillValueSeed);
	stub.skillActivationCounts.set(`${skillId}:${perspective}`, activationCount);
	return stub.scaleEffectValue(pendingSkill(skillId, perspective), effect(8), effectIdx).modifier;
}

// Buckets a scale factor into one of the 3 possible outcomes, tolerant of float representation
// rather than relying on exact `===` against 0.02/0.04 literals produced through a multiplication.
function bucket(scale: number): 0 | 1 | 2 {
	if (scale < 0.01) return 0;
	if (scale < 0.03) return 1;
	return 2;
}

test('value-scaling roll distribution matches 60%/30%/10% at 0.0x/0.02x/0.04x', t => {
	const samples = 30000;
	const nextSeed = seededSubStream(13);
	const counts = [0, 0, 0];
	for (let i = 0; i < samples; ++i) {
		counts[bucket(draw(nextSeed(), 'skill', 0, 0))]++;
	}
	const pct = (n: number) => (100 * counts[n]) / samples;
	t.ok(Math.abs(pct(0) - 60) < 2, `0.0x ~60% (got ${pct(0).toFixed(2)}%)`);
	t.ok(Math.abs(pct(1) - 30) < 2, `0.02x ~30% (got ${pct(1).toFixed(2)}%)`);
	t.ok(Math.abs(pct(2) - 10) < 2, `0.04x ~10% (got ${pct(2).toFixed(2)}%)`);
	t.end();
});

test('determinism: the same key reproduces the same draw', t => {
	const a = draw(555, 'skill', 2, 3);
	const b = draw(555, 'skill', 2, 3);
	t.equal(a, b, 'identical (skillValueSeed, skillId, perspective, effectIdx, activationCount) draws identically');
	t.end();
});

// Ruling 2 (task-2-brief.md controller rulings): the property that protects umalator's A/B
// skill-comparison feature is draw-order independence, not "identical to a specific other skill".
// A horse compares two skills, A and B; if the roll drew from a shared sequential stream (e.g.
// this.someRng.random()) instead of a fresh per-key Rule30CARng, an intervening draw for B would
// shift the stream position and desync every subsequent draw for A. Exercising ONE persistent
// stub instance across A/B/A -- rather than a fresh stub per draw() -- means any such hidden
// shared state inside the stub would actually surface here.
test('draw-order independence: an interleaved draw for a different skill does not perturb this skill\'s value', t => {
	const stub = makeStub(777);
	const drawOn = (skillId: string, effectIdx: number, activationCount: number) => {
		stub.skillActivationCounts.set(`${skillId}:${Perspective.Self}`, activationCount);
		return stub.scaleEffectValue(pendingSkill(skillId), effect(8), effectIdx).modifier;
	};

	const a1 = drawOn('skillA', 0, 0);
	drawOn('skillB', 0, 0); // interleaved, unrelated draw
	drawOn('skillB', 1, 5); // a second interleaved draw, different key entirely
	const a2 = drawOn('skillA', 0, 0);

	t.equal(a1, a2, 'skill A draws the same value both times despite interleaved skill B draws');
	t.end();
});

test('independence: different effectIdx values on one skill are not forced equal', t => {
	const nextSeed = seededSubStream(2024);
	let sawDifference = false;
	for (let i = 0; i < 200 && !sawDifference; ++i) {
		const seed = nextSeed();
		if (draw(seed, 'skill', 0, 0) !== draw(seed, 'skill', 1, 0)) sawDifference = true;
	}
	t.ok(sawDifference, 'effectIdx participates in the key -- varying it changes the roll at least sometimes');
	t.end();
});

test('independence: different activationCount values on one skill are not forced equal', t => {
	const nextSeed = seededSubStream(4048);
	let sawDifference = false;
	for (let i = 0; i < 200 && !sawDifference; ++i) {
		const seed = nextSeed();
		if (draw(seed, 'skill', 0, 0) !== draw(seed, 'skill', 0, 1)) sawDifference = true;
	}
	t.ok(sawDifference, 'activationCount participates in the key -- varying it changes the roll at least sometimes');
	t.end();
});

test('independence: effectIdx and activationCount streams are not correlated with each other', t => {
	// If effectIdx were (incorrectly) ignored, drawing at effectIdx 0 and 1 across many
	// activationCounts would match every single time. Two truly-independent 3-outcome draws
	// (60/30/10) agree with probability 0.6^2+0.3^2+0.1^2 = 0.46; a bug that ties the two
	// together would push the match rate towards 1.0. Loose one-sided bound to avoid flaking
	// on ordinary sampling noise while still catching that failure mode.
	const samples = 4000;
	const nextSeed = seededSubStream(90210);
	let matches = 0;
	for (let i = 0; i < samples; ++i) {
		const seed = nextSeed();
		if (bucket(draw(seed, 'skill', 0, i)) === bucket(draw(seed, 'skill', 1, i))) matches++;
	}
	const rate = matches / samples;
	t.ok(rate < 0.65, `effectIdx-0 vs effectIdx-1 match rate stays well under a forced-identical 1.0 (got ${rate.toFixed(3)})`);
	t.end();
});

test('pass-through: valueUsage 1 ("Direct") leaves the modifier untouched', t => {
	const stub = makeStub(1);
	const out = stub.scaleEffectValue(pendingSkill('skill'), effect(1, 5), 0);
	t.equal(out.modifier, 5, 'modifier is unchanged when valueUsage is 1');
	t.end();
});

test('pass-through: valueUsage undefined leaves the modifier untouched', t => {
	const stub = makeStub(1);
	const out = stub.scaleEffectValue(pendingSkill('skill'), effect(undefined, 5), 0);
	t.equal(out.modifier, 5, 'modifier is unchanged when valueUsage is undefined');
	t.end();
});
