// SKL-7: ability_value_usage / ability_time_usage scaling.
//
// Deliberately dependency-free -- no RaceSolver import, no DOM -- so mackoz/uma-tools' Preact
// skill picker can import the same tables the solver uses. Mirroring these constants in the UI
// instead is what let HP-6 nearly ship a picker reading "-100.0% HP drain"; importing them makes
// that class of divergence impossible rather than review-prevented.
//
// Only the codes this engine can genuinely compute are implemented. Everything else returns
// exactly 1.0, for a stated reason:
//
//   value 3-7, 10, 12, 24  training-scenario or account state (Aoharu team stats, Climax races
//                          won, Grand Live fan count, L'Arc potential). Mostly approximated at
//                          the documented 1.2x ceiling in tools/make_skill_data.pl instead --
//                          but usage 12 is only partially covered: of its three skills
//                          (210071, 210072, 210351), only the first two are in that script's
//                          @scenario_skills, so 210351 gets no approximation at all and its
//                          stored modifier is the unscaled base value. SKL-32 owns that gap.
//   value 19, 20, 21, 25   field/blocking/lead state ActivationConditions.ts samples from a
//   time  2, 4, 5, 6       distribution rather than models, so the input does not exist here.
//   value 14               needs skill-tag 601-615 data absent from skill_data.json.
//   value 11, 26-40        undocumented -- no table exists in game-mechanics/skills.md.
//   time  8                undocumented.
//   value 8, 9             "Multiply Random" -- stochastic, so it cannot be a pure function of
//                          the context. RaceSolver.scaleEffectValue() handles it before calling
//                          here, and components/SkillEffectValue.ts does the same. Returning 1.0
//                          for it here is correct *because* both callers branch first.
export interface ScalingContext {
	skillCount: number;   // value 2  -- distinct skills equipped on this uma
	maxBaseStat: number;  // value 13 -- max of the 5 base stats, captured before green skills
	finalSpeed: number;   // value 22, 23 -- horse.speed at activation, including skill effects
	remainingHp: number;  // time 3, 7 -- hp at activation, in GameHpPolicy's units
}

// [upperBoundExclusive, factor], ascending, terminated by an Infinity catch-all.
type Brackets = readonly (readonly [number, number])[];

function lookup(table: Brackets, value: number): number {
	for (const [bound, factor] of table) {
		if (value < bound) return factor;
	}
	// Reached for exactly one input: `value === Infinity`, since the comparison is strict and
	// every table's terminal bound is Infinity. That is not a hypothetical -- NoopHpPolicy's
	// hpRemaining() returns Infinity, so every non-`compare` simulation path lands here and gets
	// no duration scaling at all rather than the top bracket. Correct for a path that doesn't
	// model HP (see HpPolicy.ts's NoopHpPolicy and
	// docs/adr/0013-value-scaling-identity-fallthrough.md), and it is also the general identity
	// fallthrough if a table ever ends without an Infinity catch-all. Don't "simplify" the
	// terminal bracket away on the assumption this line is dead.
	return 1.0;
}

// game-mechanics/skills.md -- Value Scaling
const MAX_BASE_STAT: Brackets = [[600, 0.8], [800, 0.9], [1000, 1.0], [1100, 1.1], [Infinity, 1.2]];
const SPEED_TYPE_1:  Brackets = [[1700, 0.0], [1800, 1.0], [1900, 2.0], [2000, 3.0], [Infinity, 4.0]];
const SPEED_TYPE_2:  Brackets = [[1400, 1.0], [1600, 2.0], [Infinity, 3.0]];

// game-mechanics/skills.md -- Duration Scaling
const REMAIN_HP_TYPE_1: Brackets =
	[[2000, 1.0], [2400, 1.5], [2600, 2.0], [2800, 2.2], [3000, 2.5], [3200, 3.0], [3500, 3.5], [Infinity, 4.0]];
const REMAIN_HP_TYPE_2: Brackets =
	[[1500, 1.0], [1800, 1.5], [2000, 2.0], [2100, 2.5], [Infinity, 3.0]];

export function valueScaleFactor(valueUsage: number | undefined, ctx: ScalingContext): number {
	switch (valueUsage) {
	case 2:  return Math.min(1 + 0.01 * ctx.skillCount, 1.2);
	case 13: return lookup(MAX_BASE_STAT, ctx.maxBaseStat);
	case 22: return lookup(SPEED_TYPE_1, ctx.finalSpeed);
	case 23: return lookup(SPEED_TYPE_2, ctx.finalSpeed);
	default: return 1.0;
	}
}

export function durationScaleFactor(timeUsage: number | undefined, ctx: ScalingContext): number {
	switch (timeUsage) {
	case 3: return lookup(REMAIN_HP_TYPE_1, ctx.remainingHp);
	case 7: return lookup(REMAIN_HP_TYPE_2, ctx.remainingHp);
	default: return 1.0;
	}
}
