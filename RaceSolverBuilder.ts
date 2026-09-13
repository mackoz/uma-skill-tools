import { HorseParameters, Strategy, Aptitude, StrategyProficiencyModifier } from './HorseTypes';
import { CourseData, CourseHelpers, DistanceType } from './CourseData';
import { Region, RegionList } from './Region';
import { deriveSeed, Rule30CARng, SeededRng } from './Random';
import { Conditions, random, immediate, noopRandom, noopImmediate } from './ActivationConditions';
import { ActivationSamplePolicy, ImmediatePolicy, RandomPolicy, AllCornerRandomPolicy, DistributionRandomPolicy } from './ActivationSamplePolicy';
import { getParser } from './ConditionParser';
import { RaceSolver, RaceState, PendingSkill, DynamicCondition, SkillType, SkillTypeValues, SkillRarity, SkillEffect, Perspective, PosKeepMode } from './RaceSolver';
import { Mood, GroundCondition, Weather, Season, Time, Grade, RaceParameters } from './RaceParameters';
import { GameHpPolicy, NoopHpPolicy } from './HpPolicy';

import skills from './data/jp/skill_data.json';

type PartialRaceParameters = Omit<{ -readonly [K in keyof RaceParameters]: RaceParameters[K] }, 'skillId'>;

export interface HorseDesc {
	speed: number
	stamina: number
	power: number
	guts: number
	wisdom: number
	strategy: string | Strategy
	distanceAptitude: string | Aptitude
	surfaceAptitude: string | Aptitude
	strategyAptitude: string | Aptitude
	mood: Mood
	skills?: string[]
}

const GroundSpeedModifier = Object.freeze([
	null, // ground types started at 1
	[0, 0, 0, 0, -50],
	[0, 0, 0, 0, -50]
].map(o => Object.freeze(o)));

const GroundPowerModifier = Object.freeze([
	null,
	[0, 0, -50, -50, -50],
	[0, -100, -50, -100, -100]
].map(o => Object.freeze(o)));

namespace Asitame {
	export const StrategyDistanceCoefficient = Object.freeze([
		[],  // distances are 1-indexed (as are strategies, hence the 0 in the first column for every row)
		[0, 1.0, 0.7, 0.75,  0.7,  1.0],  // short (nige, senkou, sasi, oikomi, oonige)
		[0, 1.0, 0.8, 0.7,   0.75, 1.0],  // mile
		[0, 1.0, 0.9, 0.875, 0.86, 1.0],  // medium
		[0, 1.0, 0.9, 1.0,   0.9,  1.0]   // long
	]);

	export const BaseModifier = 0.00875;

	export function calcApproximateModifier(power: number, strategy: Strategy, distance: DistanceType) {
		return BaseModifier * Math.sqrt(power - 1200) * StrategyDistanceCoefficient[distance][strategy];
	}
}

namespace StaminaSyoubu {
	export function distanceFactor(distance: number) {
		if (distance < 2101) return 0.0;
		else if (distance < 2201) return 0.5;
		else if (distance < 2401) return 1.0;
		else if (distance < 2601) return 1.2;
		else return 1.5;
	}

	export function calcApproximateModifier(stamina: number, distance: number) {
		const randomFactor = 1.0;  // TODO implement random factor scaling based on power (unclear how this works currently)
		return Math.sqrt(stamina - 1200) * 0.0085 * distanceFactor(distance) * randomFactor;
	}
}

export function parseStrategy(s: string | Strategy) {
	if (typeof s != 'string') {
		return s;
	}
	switch (s.toUpperCase()) {
	case 'NIGE': return Strategy.Nige;
	case 'SENKOU': return Strategy.Senkou;
	case 'SASI':
	case 'SASHI': return Strategy.Sasi;
	case 'OIKOMI': return Strategy.Oikomi;
	case 'OONIGE': return Strategy.Oonige;
	default: throw new Error('Invalid running strategy.');
	}
}

export function parseAptitude(a: string | Aptitude, type: string) {
	if (typeof a != 'string') {
		return a;
	}
	switch (a.toUpperCase()) {
	case 'S': return Aptitude.S;
	case 'A': return Aptitude.A;
	case 'B': return Aptitude.B;
	case 'C': return Aptitude.C;
	case 'D': return Aptitude.D;
	case 'E': return Aptitude.E;
	case 'F': return Aptitude.F;
	case 'G': return Aptitude.G;
	default: throw new Error('Invalid ' + type + ' aptitude.');
	}
}

export function parseGroundCondition(g: string | GroundCondition) {
	if (typeof g != 'string') {
		return g;
	}
	switch (g.toUpperCase()) {
	case 'GOOD': return GroundCondition.Good;
	case 'YIELDING': return GroundCondition.Yielding;
	case 'SOFT': return GroundCondition.Soft;
	case 'HEAVY': return GroundCondition.Heavy;
	default: throw new Error('Invalid ground condition.');
	}
}

export function parseWeather(w: string | Weather) {
	if (typeof w != 'string') {
		return w;
	}
	switch (w.toUpperCase()) {
	case 'SUNNY': return Weather.Sunny;
	case 'CLOUDY': return Weather.Cloudy;
	case 'RAINY': return Weather.Rainy;
	case 'SNOWY': return Weather.Snowy;
	default: throw new Error('Invalid weather.');
	}
}

export function parseSeason(s: string | Season) {
	if (typeof s != 'string') {
		return s;
	}
	switch (s.toUpperCase()) {
	case 'SPRING': return Season.Spring;
	case 'SUMMER': return Season.Summer;
	case 'AUTUMN': return Season.Autumn;
	case 'WINTER': return Season.Winter;
	case 'SAKURA': return Season.Sakura;
	default: throw new Error('Invalid season.');
	}
}

export function parseTime(t: string | Time) {
	if (typeof t != 'string') {
		return t;
	}
	switch (t.toUpperCase()) {
	case 'NONE': case 'NOTIME': return Time.NoTime;
	case 'MORNING': return Time.Morning;
	case 'MIDDAY': return Time.Midday;
	case 'EVENING': return Time.Evening;
	case 'NIGHT': return Time.Night;
	default: throw new Error('Invalid race time.');
	}
}

export function parseGrade(g: string | Grade) {
	if (typeof g != 'string') {
		return g;
	}
	switch (g.toUpperCase()) {
	case 'G1': return Grade.G1;
	case 'G2': return Grade.G2;
	case 'G3': return Grade.G3;
	case 'OP': return Grade.OP;
	case 'PRE-OP': case 'PREOP': return Grade.PreOP;
	case 'MAIDEN': return Grade.Maiden;
	case 'DEBUT': return Grade.Debut;
	case 'DAILY': return Grade.Daily;
	default: throw new Error('Invalid race grade.');
	}
}

function adjustOvercap(stat: number) {
	return stat > 1200 ? 1200 + Math.floor((stat - 1200) / 2) : stat;
}

export function buildBaseStats(horseDesc: HorseDesc, mood: Mood) {
	const motivCoef = 1 + 0.02 * horseDesc.mood;

	const speed = adjustOvercap(horseDesc.speed) * motivCoef;
	const stamina = adjustOvercap(horseDesc.stamina) * motivCoef;
	const power = adjustOvercap(horseDesc.power) * motivCoef;
	const guts = adjustOvercap(horseDesc.guts) * motivCoef;
	const wisdom = adjustOvercap(horseDesc.wisdom) * motivCoef;

	return Object.freeze({
		speed,
		stamina,
		power,
		guts,
		wisdom,
		strategy: parseStrategy(horseDesc.strategy),
		distanceAptitude: parseAptitude(horseDesc.distanceAptitude, 'distance'),
		surfaceAptitude: parseAptitude(horseDesc.surfaceAptitude, 'surface'),
		strategyAptitude: parseAptitude(horseDesc.strategyAptitude, 'strategy'),
		rawStamina: horseDesc.stamina * motivCoef,
		rawWisdom: adjustOvercap(horseDesc.wisdom) * motivCoef,
		// SKL-7: value usage 13 scales on the maximum *raw* stat (game-mechanics/skills.md),
		// so this is taken here -- post-motivation, post-overcap, pre-course-modifier.
		// ANCHOR: base-stats-max-raw-stat
		maxRawStat: Math.max(speed, stamina, power, guts, wisdom)
	});
}

export function buildAdjustedStats(baseStats: HorseParameters, course: CourseData, ground: GroundCondition) {
	const raceCourseModifier = CourseHelpers.courseSpeedModifier(course, baseStats);

	// ANCHOR: adjusted-stats-return
	return Object.freeze({
		speed: Math.max(baseStats.speed * raceCourseModifier + GroundSpeedModifier[course.surface][ground], 1),
		stamina: baseStats.stamina,
		power: Math.max(baseStats.power + GroundPowerModifier[course.surface][ground], 1),
		guts: baseStats.guts,
		wisdom: baseStats.wisdom * StrategyProficiencyModifier[baseStats.strategyAptitude],
		strategy: baseStats.strategy,
		distanceAptitude: baseStats.distanceAptitude,
		surfaceAptitude: baseStats.surfaceAptitude,
		strategyAptitude: baseStats.strategyAptitude,
		rawStamina: baseStats.rawStamina,
		rawWisdom: baseStats.rawWisdom,
		maxRawStat: baseStats.maxRawStat
	});
}

export const enum SkillTarget {
	Self = 1,
	All = 2,
	InFov = 4,
	AheadOfPosition = 7,
	AheadOfSelf = 9,
	BehindSelf = 10,
	AllAllies = 11,
	EnemyStrategy = 18,
	KakariAhead = 19,
	KakariBehind = 20,
	KakariStrategy = 21,
	UmaId = 22,
	UsedRecovery = 23
}

export { Perspective } from './RaceSolver';

export interface SkillData {
	skillId: string
	perspective?: Perspective
	rarity: SkillRarity
	samplePolicy: ActivationSamplePolicy,
	regions: RegionList,
	extraCondition: DynamicCondition,
	effects: SkillEffect[],
	cooldown?: number
	originWisdom?: number
	victimSafe?: boolean
}

// SKL-21. Whether a sample policy actually places more than one candidate trigger point, i.e.
// whether requesting spares for it means anything. Per plans/condition-reference/conditions.md:
// - `all_corner_random` (AllCornerRandomPolicy, :125) rolls FOUR points total, not necessarily one
//   per corner -- `placeSuccessive` can place two points in the same corner, and conditions.md:125
//   itself says the game re-rolls a random corner (with replacement) each time too. Either way,
//   multiple points exist for a short-cooldown skill to re-arm into.
// - `straight_random` (StraightRandomPolicy, :1493) rolls a straight segment, then ONE point on
//   it -- a single point, no matter how many straights the course has.
// - `is_finalcorner_random` (RandomPolicy, :675) rolls ONE point on the (single) final corner.
// - DistributionRandomPolicy and its subclasses (Uniform/LogNormal/Erlang) model conditions that
//   are continuously re-evaluated in the real game; unlike the other three, requesting spares for
//   them is NOT a no-op "regardless of cooldown" -- sample() draws nsamples*(1+spares) and returns
//   early when spares==0, so the candidate count is exactly a function of the spares requested.
//   They keep spares because real replays show 7 genuine re-triggers in that family (see
//   tools/replay/cooldownReport.ts and the :923 comment below), not because the policy would place
//   multiple points unconditionally either way.
// Requesting spares for a policy that only ever places one point would be a no-op at best (the
// policy pads the request out with inert zero-length regions) and is excluded here so the spares
// count documents something true about the policy, not just "harmless either way."
function samplePolicyPlacesMultiplePoints(sp: ActivationSamplePolicy): boolean {
	return sp === AllCornerRandomPolicy || sp instanceof DistributionRandomPolicy;
}

// ANCHOR: victim-safe-condition-allowlist
// Terms that say WHEN a debuff lands or WHICH COURSES the skill can exist on. Everything else in a
// debuff's condition describes the *caster* -- their order, running style, who is blocking them --
// and buildSkillData evaluates conditions against the builder's own horse, i.e. the victim. See
// docs/adr/0014-victim-safe-debuff-conditions.md.
//
// Allowlist rather than denylist, deliberately: a caster term introduced by a future data refresh
// that slipped past a denylist would evaluate against the victim and make that debuff silently
// never fire. Over-stripping instead widens the firing window -- wrong, but observable, and
// test/victim-safe-condition.test.ts fails on any unclassified term either way.
//
// running_style_count_{nige,senko,sashi,oikomi}_otherself are victim-safe DESPITE the "_otherself"
// name, and must NOT be stripped: ActivationConditions.ts's own comment above their entries
// explains these are used exclusively on debuffs, where they are added to /us/ from
// the "other" perspective -- and each is implemented as
// `valueFilter((_, horse) => +StrategyHelpers.strategyMatches(horse.strategy, Strategy.X))`, i.e.
// it reads `horse.strategy` off the builder's OWN horse, which under addOpponentDebuff's rewrite
// IS the victim. So evaluated unmodified, these already ask "is the victim a Front
// Runner/Pace Chaser/Late Surger/End Closer" -- exactly the victim-safe question a
// running-style-gated debuff (e.g. the Subdued/Flustered family, 200831 et al.) needs answered.
// Stripping them (as this allowlist wrongly did before HP-7's fix) makes those debuffs apply to
// every running style instead of gating on the victim's, per ActivationConditions.ts.
export const VictimSafeConditions: ReadonlySet<string> = new Set([
	'phase', 'phase_random', 'accumulatetime', 'distance_type',
	'running_style_count_nige_otherself', 'running_style_count_senko_otherself',
	'running_style_count_sashi_otherself', 'running_style_count_oikomi_otherself',
]);

// ConditionParser's grammar is `Or ::= And '@' Or | And` with no parentheses, so `&` binds tighter
// than `@` and each `@`-branch's `&`-clauses filter independently. A branch that keeps nothing is
// unconditional, which makes the whole disjunction unconditional -- returned as '' for the caller
// to treat as "no condition". No shipped debuff hits that case (pinned by the test).
export function victimSafeCondition(condition: string): string {
	const branches = condition.split('@').map(branch =>
		branch.split('&')
			.filter(clause => VictimSafeConditions.has(clause.replace(/[<>=!].*/, '')))
			.join('&'));
	return branches.some(b => b.length === 0) ? '' : branches.join('@');
}

function isTarget(self: Perspective, targetType: SkillTarget) {
	return targetType == SkillTarget.All || self == Perspective.Any || ((self == Perspective.Self) == (targetType == SkillTarget.Self));
}

function buildSkillEffects(skill, perspective: Perspective) {
	return skill.effects.map(ef => ({
		type: SkillTypeValues.has(ef.type) && isTarget(perspective, ef.target) ? ef.type : SkillType.Noop,
		// ANCHOR: base-duration-scaling
		baseDuration: skill.baseDuration / 10000,
		modifier: ef.modifier / 10000,
		valueUsage: ef.valueUsage,
		timeUsage: skill.timeUsage
	}));
}

export function buildSkillData(horse: HorseParameters, raceParams: PartialRaceParameters, course: CourseData, wholeCourse: RegionList, parser: {parse: any, tokenize: any}, skillId: string, perspective: Perspective, ignoreNullEffects: boolean = false, originWisdom?: number, victimSafe: boolean = false) {
	if (!(skillId in skills)) {
		throw new Error('bad skill ID ' + skillId);
	}
	const extra = Object.assign({skillId}, raceParams);
	const alternatives = skills[skillId].alternatives;
	const triggers = [];
	for (let i = 0; i < alternatives.length; ++i) {
		const skill = alternatives[i];
		let full = new RegionList();
		wholeCourse.forEach(r => full.push(r));
		if (skill.precondition) {
			const pre = parser.parse(parser.tokenize(skill.precondition));
			const preRegions = pre.apply(wholeCourse, course, horse, extra)[0];
			if (preRegions.length == 0) {
				continue;
			} else {
				const bounds = new Region(preRegions[0].start, wholeCourse[wholeCourse.length-1].end);
				full = full.rmap(r => r.intersect(bounds));
			}
		}

		// HP-7: an incoming debuff's condition is rewritten to drop caster-state terms before it is
		// parsed -- see victimSafeCondition above. A fully-stripped condition ('') means the skill
		// is unconditional over `full`, which the parser has no representation for, so short-circuit.
		const conditionText = victimSafe ? victimSafeCondition(skill.condition) : skill.condition;
		let regions: RegionList, extraCondition: DynamicCondition, samplePolicy: ActivationSamplePolicy;
		if (victimSafe && conditionText === '') {
			regions = full;
			extraCondition = (_) => true;
			samplePolicy = RandomPolicy;
		} else {
			const op = parser.parse(parser.tokenize(conditionText));
			[regions, extraCondition] = op.apply(full, course, horse, extra);
			// Stripping a randomizing caster term can leave a policy that fires at the exact region
			// boundary every sample (bare `phase` carries ImmediatePolicy). A debuff lands at an
			// arbitrary moment in its window, so force a uniform draw.
			samplePolicy = victimSafe ? RandomPolicy : op.samplePolicy;
		}
		if (regions.length == 0) {
			continue;
		}
		// ANCHOR: second-trigger-detail-guard
		if (triggers.length > 0 && !/is_activate_other_skill_detail|is_used_skill_id/.test(skill.condition)) {
			// i don't like this at all. the problem is some skills with two triggers (for example all the is_activate_other_skill_detail ones)
			// need to place two triggers so the second effect can activate, however, some other skills with two triggers only ever activate one
			// even if they have non-mutually-exclusive conditions (for example Jungle Pocket unique). i am not currently sure what distinguishes
			// them in the game implementation. it's pretty inconsistent about whether double-trigger skills force the conditions to be mutually
			// exclusive or not even if it only wants one of them to activate; for example Daitaku Helios unique ensures the distance conditions
			// are mutually exclusive for both triggers but Jungle Pocket doesn't. for the time being we're only going to place the first trigger
			// unless the second one is explicitly is_activate_other_skill_detail or is_used_skill_id (need this for NY Ace).
			// !!! FIXME this is actually bugged for NY Ace unique since she'll get both effects if she uses oonige.
			continue;
		}
		const effects = buildSkillEffects(skill, perspective);
		if (effects.length > 0 || ignoreNullEffects) {
			const rarity = skills[skillId].rarity;
			triggers.push({
				skillId: skillId,
				perspective: perspective,
				// for some reason 1*/2* uniques, 1*/2* upgraded to 3*, and naturally 3* uniques all have different rarity (3, 4, 5 respectively)
				rarity: rarity >= 3 && rarity <= 5 ? 3 : rarity,
				samplePolicy,
				regions: regions,
				extraCondition: extraCondition,
				effects: effects,
				cooldown: skill.cooldown,
				originWisdom: originWisdom,
				victimSafe: victimSafe
			});
		}
	}
	if (triggers.length > 0) return triggers;
	// if we get here, it means that no alternatives have their conditions satisfied for this course/horse.
	// however, for purposes of summer goldship unique (Adventure of 564), we still have to add something, since
	// that could still cause them to activate. so just add the first alternative at a location after the course
	// is over with a constantly false dynamic condition so that it never activates normally.
	const effects = buildSkillEffects(alternatives[0], perspective);
	if (effects.length == 0 && !ignoreNullEffects) {
		return [];
	} else {
		const rarity = skills[skillId].rarity;
		const afterEnd = new RegionList();
		afterEnd.push(new Region(9999,9999));
		return [{
			skillId: skillId,
			perspective: perspective,
			rarity: rarity >= 3 && rarity <= 5 ? 3 : rarity,
			samplePolicy: ImmediatePolicy,
			regions: afterEnd,
			extraCondition: (_) => false,
			effects: effects,
			originWisdom: originWisdom,
			victimSafe: victimSafe
		}];
	}
}

export const conditionsWithActivateCountsAsRandom = Object.freeze(Object.assign({}, Conditions, {
	activate_count_all: random({
		filterGte(regions: RegionList, n: number, course: CourseData, _1: HorseParameters, extra: RaceParameters) {
			// hard-code TM Opera O (NY) unique and Neo Universe unique to pretend they're immediate while allowing randomness for other skills
			// (conveniently the only two with n == 7)
			// ideally find a better solution
			if (n == 7) {
				const rl = new RegionList();
				// note that RandomPolicy won't sample within 10m from the end so this has to be +11
				regions.forEach(r => rl.push(new Region(r.start, r.start + 11)));
				return rl;
			}
			/*if (extra.skillId == '110151' || extra.skillId == '910151') {
				const rl = new RegionList();
				rl.push(new Region(course.distance - 401, course.distance - 399));
				return rl;
			}*/
			// somewhat arbitrarily decide you activate about 23 skills per race and then use a region n / 23 ± 20%
			const bounds = new Region(Math.min(n / 23.0 - 0.2, 0.6) * course.distance, Math.min(n / 23.0 + 0.2, 1.0) * course.distance);
			return regions.rmap(r => r.intersect(bounds));
		},
		filterLte(regions: RegionList, n: number, course: CourseData, _1: HorseParameters, extra: RaceParameters) {
			return new RegionList();  // tentatively, we're not really interested in the <= branch of these conditions
		}
	}),
	activate_count_end_after: random({
		filterGte(regions: RegionList, _0: number, course: CourseData, _1: HorseParameters, extra: RaceParameters) {
			const bounds = new Region(CourseHelpers.phaseStart(course.distance, 2), CourseHelpers.phaseEnd(course.distance, 3));
			return regions.rmap(r => r.intersect(bounds));
		}
	}),
	activate_count_heal: noopRandom,
	activate_count_later_half: random({
		filterGte(regions: RegionList, _0: number, course: CourseData, _1: HorseParameters, extra: RaceParameters) {
			const bounds = new Region(course.distance / 2, course.distance);
			return regions.rmap(r => r.intersect(bounds));
		}
	}),
	activate_count_middle: random({
		filterGte(regions: RegionList, n: number, course: CourseData, _1: HorseParameters, extra: RaceParameters) {
			const start = CourseHelpers.phaseStart(course.distance, 1), end = CourseHelpers.phaseEnd(course.distance, 1);
			const bounds = new Region(start, start + n / 10 * (end - start));
			return regions.rmap(r => r.intersect(bounds));
		}
	}),
	activate_count_start: immediate({  // for 地固め
		filterGte(regions: RegionList, _0: number, course: CourseData, _1: HorseParameters, extra: RaceParameters) {
			const bounds = new Region(CourseHelpers.phaseStart(course.distance, 0), CourseHelpers.phaseEnd(course.distance, 0));
			return regions.rmap(r => r.intersect(bounds));
		}
	}),
	// Base definition (ActivationConditions.ts) is `s.activateCountLastFrame > 0` -- true the frame
	// after *any* skill activates. Unlike the six activate_count_* names above (distance/count
	// thresholds we can approximate with a region), this is an instantaneous per-frame check, so
	// noopImmediate ("unconditionally satisfied") matches its own semantics more closely than
	// noopRandom would -- there's no threshold to turn into a sampling window. Every unique
	// currently using this condition also carries its own phase/corner/style clauses, so this
	// doesn't degenerate into "fires at the start line" -- those clauses still bound it.
	is_activate_any_skill: noopImmediate
}));

const defaultParser = getParser();
const acrParser = getParser(conditionsWithActivateCountsAsRandom);

export class RaceSolverBuilder {
	_course: CourseData | null
	_raceParams: PartialRaceParameters
	_horse: HorseDesc | null
	_pacerSkills: PendingSkill[]
	_pacerSkillIds: string[]
	_pacerSpeedUpRate: number
	_pacerSkillData: SkillData[];
	_pacerTriggersBySlot: {flat: Region[], spares: number}[][];
	_rng: SeededRng
	_seed: number
	_parser: {parse: any, tokenize: any}
	_skills: {id: string, p: Perspective, originWisdom?: number, victimSafe?: boolean}[]
	_samplePolicyOverride: Map<string, ActivationSamplePolicy>
	_extraSkillHooks: ((skilldata: SkillData[], horse: HorseParameters, course: CourseData) => void)[]
	_onSkillActivate: (state: RaceSolver, skillId: string) => void
	_onSkillDeactivate: (state: RaceSolver, skillId: string) => void
	_posKeepMode: PosKeepMode
	_mode: string | undefined
	_skillWisdomCheck: boolean | undefined
	_rushedKakari: boolean | undefined
	_competeFight: boolean | undefined
	_leadCompetition: boolean | undefined
	_laneMovement: boolean | undefined
	_duelingRates: {
		runaway: number,
		frontRunner: number,
		paceChaser: number,
		lateSurger: number,
		endCloser: number
	} | undefined

	constructor(readonly nsamples: number) {
		this._course = null;
		this._raceParams = {
			mood: 2,
			groundCondition: GroundCondition.Good,
			weather: Weather.Sunny,
			season: Season.Spring,
			time: Time.Midday,
			grade: Grade.G1,
			popularity: 1
		};
		this._horse = null;
		this._pacerSkillData = [];
		this._pacerTriggersBySlot = [];
		this._pacerSkills = [];
		this._pacerSkillIds = [];
		this._pacerSpeedUpRate = 100;
		this._seed = Math.floor(Math.random() * (-1 >>> 0)) >>> 0;
		this._rng = new Rule30CARng(this._seed);
		this._parser = defaultParser;
		this._skills = [];
		this._samplePolicyOverride = new Map();
		this._extraSkillHooks = [];
		this._onSkillActivate = null;
		this._onSkillDeactivate = null;
		this._posKeepMode = PosKeepMode.None;
		this._mode = undefined;
		this._skillWisdomCheck = undefined;
		this._rushedKakari = undefined;
		this._competeFight = undefined;
		this._leadCompetition = undefined;
		this._laneMovement = undefined;
		this._duelingRates = undefined;
	}

	seed(seed: number) {
		this._seed = seed;
		this._rng = new Rule30CARng(seed);
		return this;
	}

	course(course: number | CourseData) {
		if (typeof course == 'number') {
			this._course = CourseHelpers.getCourse(course);
		} else {
			this._course = course;
		}
		return this;
	}

	mood(mood: Mood) {
		this._raceParams.mood = mood;
		return this;
	}

	ground(ground: string | GroundCondition) {
		this._raceParams.groundCondition = parseGroundCondition(ground);
		return this;
	}

	weather(weather: string | Weather) {
		this._raceParams.weather = parseWeather(weather);
		return this;
	}

	season(season: string | Season) {
		this._raceParams.season = parseSeason(season);
		return this;
	}

	time(time: string | Time) {
		this._raceParams.time = parseTime(time);
		return this;
	}

	grade(grade: string | Grade) {
		this._raceParams.grade = parseGrade(grade);
		return this;
	}

	popularity(popularity: number) {
		this._raceParams.popularity = popularity;
		return this;
	}

	order(start: number, end: number) {
		this._raceParams.orderRange = [start,end];
		return this;
	}

	numUmas(n: number) {
		this._raceParams.numUmas = n;
		return this;
	}

	horse(horse: HorseDesc) {
		this._horse = horse;
		return this;
	}
	
	pacerSpeedUpRate(rate: number) {
		this._pacerSpeedUpRate = rate;
		return this;
	}

	getSamplePolicyKey(skillId: string, perspective: Perspective): string {
		return `${skillId}:${perspective}`;
	}

	_isNige() {
		if (typeof this._horse.strategy == 'string') {
			return this._horse.strategy.toUpperCase() == 'NIGE' || this._horse.strategy.toUpperCase() == 'OONIGE';
		} else {
			return this._horse.strategy == Strategy.Nige || this._horse.strategy == Strategy.Oonige;
		}
	}

	setupPacer(horse: HorseDesc) {
		const pacer = horse;
		const pacerBaseHorse = pacer ? buildBaseStats(pacer, pacer.mood) : null;
		const pacerHorse = pacer ? buildAdjustedStats(pacerBaseHorse, this._course, this._raceParams.groundCondition) : null;

		const wholeCourse = new RegionList();
		wholeCourse.push(new Region(0, this._course.distance));
		Object.freeze(wholeCourse);

		let pacerSkillData: SkillData[] = [];
		
		if (pacerBaseHorse) {
			this._pacerSkillIds = horse.skills ?? [];
			const makePacerSkill = buildSkillData.bind(null, pacerBaseHorse, this._raceParams, this._course, wholeCourse, this._parser);
			pacerSkillData = this._pacerSkillIds.flatMap(id => makePacerSkill(id, Perspective.Self));
			this._pacerSkillData = pacerSkillData;
		}

		return pacerHorse
	}

	// Samples each pacer skill's full nsamples-length trigger table once per pacemaker slot,
	// instead of buildPacer resampling the whole table on every scenario (only to use one
	// index of it) -- that was an O(nsamples) cost paid nsamples times per pacemaker, i.e.
	// quadratic in the sample count. Slots exist because a single pacer skill config
	// (_pacerSkillData) can back multiple simultaneous pacemakers (Virtual position-keep with
	// pacemakerCount > 1), each of which should still see distinct trigger positions.
	//
	// Idempotent for a given (baseSeed, pacerSlots): call once before the scenario loop.
	prepPacerTriggers(pacerSlots: number, baseSeed: number) {
		this._pacerTriggersBySlot = [];

		for (let slot = 0; slot < pacerSlots; ++slot) {
			let pacerTriggers: {flat: Region[], spares: number}[] = [];

			if (this._pacerSkillIds.length > 0) {
				const triggerSeed = deriveSeed(baseSeed, `pacer-triggers:${slot}`);
				const occurrences = new Map<string, number>();
				// HP-7 review-4 (E-I1): victim-safe entries get their own occurrence-count and seed
				// namespace -- see the identical map and the full rationale at the same site in build()
				// below.
				const debuffOccurrences = new Map<string, number>();
				// SKL-21: identical spares treatment to build()'s main sampling -- a cooldown skill on a
				// pacemaker must be able to activate more than once too. SPARES=3 (+1 primary = 4
				// candidates) matches all_corner_random's own four-point roll exactly -- see
				// plans/condition-reference/conditions.md:125 ("randomly picks four points... if the
				// skill in question has a short cooldown, there are multiple points where it can
				// activate this way"). Only requested for policies that actually place more than one
				// point (see samplePolicyPlacesMultiplePoints()) -- straight_random/is_finalcorner_random
				// (conditions.md:1493/:675) each place exactly one point and so get 0 regardless of
				// cooldown, matching their documented single-point behavior.
				const SPARES = 3;
				pacerTriggers = this._pacerSkillData.map(sd => {
					const key = sd.perspective != null ? this.getSamplePolicyKey(sd.skillId, sd.perspective) : sd.skillId;
					// HP-7 review-4 (E-I1): count victim-safe occurrences in their own map, not the shared
					// one every other Perspective.Other add path counts into -- see the seed derivation
					// below for why.
					const occMap = sd.victimSafe ? debuffOccurrences : occurrences;
					const occurrence = occMap.get(key) || 0;
					occMap.set(key, occurrence + 1);
					// HP-7 review-3 fix 1: a victim-safe debuff's forced RandomPolicy (buildSkillData)
					// must never be overridable -- see the identical guard and comment in build() below.
					const sp = sd.victimSafe ? sd.samplePolicy : (this._samplePolicyOverride.get(key) || sd.samplePolicy);
					const spares = sd.cooldown != null && samplePolicyPlacesMultiplePoints(sp) ? SPARES : 0;
					// HP-7 review-4 (E-I1): seed from a `:debuff:`-namespaced key for victim-safe entries too
					// -- `occurrence` alone isn't enough, since the shared `occurrences` map above only
					// tracked one shared count for the key. Namespacing both means the presence of an
					// unrelated same-id Perspective.Other add can no longer shift a debuff's RNG stream.
					const seedKey = sd.victimSafe ? `${key}:debuff:${occurrence}` : `${key}:${occurrence}`;
					const flat = sp.sample(sd.regions, this.nsamples, new Rule30CARng(deriveSeed(triggerSeed, seedKey)), spares);
					return {flat, spares};
				});
			}

			this._pacerTriggersBySlot.push(pacerTriggers);
		}
	}

	buildPacer(pacerHorse, i: number, slot: number, pacerRng: SeededRng): RaceSolver | null {
		const pacerTriggers = this._pacerTriggersBySlot[slot] || [];

		const pacerSkills = this._pacerSkillData.length > 0
			? this._pacerSkillData.map((sd, sdi) => {
				const {flat, spares} = pacerTriggers[sdi];
				const n = flat.length / (1 + spares);
				const si = i % n;
				return {
					skillId: sd.skillId,
					perspective: sd.perspective,
					rarity: sd.rarity,
					trigger: flat[si],
					extraCondition: sd.extraCondition,
					effects: sd.effects,
					cooldown: sd.cooldown,
					victimSafe: sd.victimSafe,
					spares: spares > 0 ? flat.slice(n + si * spares, n + (si + 1) * spares) : undefined
				};
			})
			: this._pacerSkills;

		return pacerHorse ? new RaceSolver({
			horse: pacerHorse,
			course: this._course,
			hp: NoopHpPolicy,
			skills: pacerSkills,
			rng: pacerRng,
			speedUpProbability: this._pacerSpeedUpRate,
			posKeepMode: this._posKeepMode,
			mode: this._mode,
			isPacer: true,
			competeFight: this._competeFight,
			leadCompetition: this._leadCompetition,
			duelingRates: this._duelingRates,
			laneMovement: this._laneMovement
		}) : null;
	}

	pacer(horse: HorseDesc) {
		return this.setupPacer(horse);
	}

	useDefaultPacer(openingLegAccel: boolean = false) {
		const pacer = Object.assign({}, this._horse, {strategy: 'Nige'});

		if (openingLegAccel) {
			// top is jiga and bottom is white sente
			// arguably it's more realistic to include these, but also a lot of the time they prevent the exact pace down effects
			// that we're trying to investigate
			this._pacerSkills = [{
				skillId: '201601',
				perspective: Perspective.Self,
				rarity: SkillRarity.White,
				trigger: new Region(0, 100),
				extraCondition: (_) => true,
				effects: [{type: SkillType.Accel, baseDuration: 3.0, modifier: 0.2}]
			}, {
				skillId: '200532',
				perspective: Perspective.Self,
				rarity: SkillRarity.White,
				trigger: new Region(0, 100),
				extraCondition: (_) => true,
				effects: [{type: SkillType.Accel, baseDuration: 1.2, modifier: 0.2}]
			}];
		}

		return this.setupPacer(pacer);
	}

	withActivateCountsAsRandom() {
		this._parser = acrParser;
		return this;
	}

	// NB. must be called after horse and mood are set
	withAsiwotameru() {
		// for some reason, asitame (probably??) uses *displayed* power adjusted for motivation + greens
		const baseDisplayedPower = this._horse.power * (1 + 0.02 * this._raceParams.mood);
		this._extraSkillHooks.push((skilldata, horse, course) => {
			const power = skilldata.reduce((acc,sd) => {
				const powerUp = sd.effects.find(ef => ef.type == SkillType.PowerUp);
				if (powerUp && sd.regions.length > 0 && sd.regions[0].start < 9999) {
					return acc + powerUp.modifier;
				} else {
					return acc;
				}
			}, baseDisplayedPower);

			if (power > 1200) {
				const spurtStart = new RegionList();
				spurtStart.push(new Region(CourseHelpers.phaseStart(course.distance, 2), course.distance));
				skilldata.push({
					skillId: 'asitame',
					perspective: Perspective.Self,
					rarity: SkillRarity.White,
					regions: spurtStart,
					samplePolicy: ImmediatePolicy,
					extraCondition: (_) => true,
					effects: [{
						type: SkillType.Accel,
						baseDuration: 3.0 / (course.distance / 1000.0),
						modifier: Asitame.calcApproximateModifier(power, horse.strategy, course.distanceType)
					}]
				});
			}
		});
		return this;
	}

	withStaminaSyoubu() {
		this._extraSkillHooks.push((skilldata, horse, course) => {
			// unfortunately the simulator doesnt (yet) support dynamic modifiers, so we have to account for greens here
			// even though they are later added normally during execution
			const stamina = skilldata.reduce((acc,sd) => {
				const staminaUp = sd.effects.find(ef => ef.type == SkillType.StaminaUp);
				if (staminaUp && sd.regions.length > 0 && sd.regions[0].start < 9999) {
					return acc + staminaUp.modifier;
				} else {
					return acc;
				}
			}, horse.rawStamina);

			if (stamina > 1200) {
				const spurtStart = new RegionList();
				spurtStart.push(new Region(CourseHelpers.phaseStart(course.distance, 2), course.distance));
				skilldata.push({
					skillId: 'staminasyoubu',
					perspective: Perspective.Self,
					rarity: SkillRarity.White,
					regions: spurtStart,
					samplePolicy: ImmediatePolicy,
					// TODO do current speed skills count toward reaching max speed or not?
					extraCondition: (s: RaceState) => s.currentSpeed >= s.lastSpurtSpeed,
					effects: [{
						type: SkillType.TargetSpeed,
						baseDuration: 9999.0,
						modifier: StaminaSyoubu.calcApproximateModifier(stamina, course.distance)
					}]
				});
			}
		});
		return this;
	}

	addSkill(skillId: string, perspective: Perspective = Perspective.Self, samplePolicy?: ActivationSamplePolicy, originWisdom?: number) {
		this._skills.push({id: skillId, p: perspective, originWisdom});
		if (samplePolicy != null) {
			this._samplePolicyOverride.set(this.getSamplePolicyKey(skillId, perspective), samplePolicy);
		}
		return this;
	}

	// HP-7: a stamina debuff an opponent lands on THIS horse. Added with Perspective.Other so the
	// effect applies (isTarget) but the horse gets no credit for casting it, and with its condition
	// rewritten victim-safe. Deliberately leaves `cooldown` unset: no shipped debuff carries a
	// cooldown (checked: all 30 alternatives, both datasets), and even if one did, RandomPolicy is a
	// frozen singleton -- not AllCornerRandomPolicy or a DistributionRandomPolicy -- so
	// samplePolicyPlacesMultiplePoints() returns false and it gets 0 spares regardless (SKL-21).
	addOpponentDebuff(skillId: string) {
		this._skills.push({id: skillId, p: Perspective.Other, victimSafe: true});
		return this;
	}

	/**
	 * Adds a skill that will be forced to activate at a specific distance on the track.
	 * This overrides the skill's normal activation conditions and sample policy.
	 * @param skillId The skill ID to add
	 * @param position The distance (in meters) where the skill should activate
	 * @param perspective Whether this skill is for Self or Other (default: Self)
	 * @returns this builder for chaining
	 */
	addSkillAtPosition(skillId: string, position: number, perspective: Perspective = Perspective.Self, originWisdom?: number) {
		const { createFixedPositionPolicy } = require('./ActivationSamplePolicy');
		return this.addSkill(skillId, perspective, createFixedPositionPolicy(position), originWisdom);
	}
	
	posKeepMode(mode: PosKeepMode) {
		this._posKeepMode = mode;
		return this;
	}

	mode(mode: string) {
		this._mode = mode;
		return this;
	}

	skillWisdomCheck(enabled: boolean) {
		this._skillWisdomCheck = enabled;
		return this;
	}

	rushedKakari(enabled: boolean) {
		this._rushedKakari = enabled;
		return this;
	}

	competeFight(enabled: boolean) {
		this._competeFight = enabled;
		return this;
	}

	leadCompetition(enabled: boolean) {
		this._leadCompetition = enabled;
		return this;
	}

	laneMovement(enabled: boolean) {
		this._laneMovement = enabled;
		return this;
	}

	duelingRates(rates: {
		runaway: number,
		frontRunner: number,
		paceChaser: number,
		lateSurger: number,
		endCloser: number
	}) {
		this._duelingRates = rates;
		return this;
	}

	onSkillActivate(cb: (state: RaceSolver, skillId: string) => void) {
		this._onSkillActivate = cb;
		return this;
	}

	onSkillDeactivate(cb: (state: RaceSolver, skillId: string) => void) {
		this._onSkillDeactivate = cb;
		return this;
	}

	desync() {
		this.seed(this._rng.int32());
	}

	fork() {
		const clone = new RaceSolverBuilder(this.nsamples);
		clone._course = this._course;
		clone._raceParams = Object.assign({}, this._raceParams);
		clone._horse = this._horse;
		// SKL-21: sharing the skill objects (rather than deep-cloning them) is fine only because the
		// two hardcoded entries this builds (see setupPacer()) carry no cooldown and so are never
		// passed to rearmSkill(), which now mutates a PendingSkill's `.trigger`/`.spares` in place.
		// A pacer skill that ever gained a cooldown would have its clone and original share (and
		// corrupt) the same mutable spares array across forked builders.
		clone._pacerSkills = this._pacerSkills.slice();
		clone._pacerSkillIds = this._pacerSkillIds.slice();
		clone._pacerSpeedUpRate = this._pacerSpeedUpRate;
		clone._pacerSkillData = this._pacerSkillData.slice();
		clone._pacerTriggersBySlot = this._pacerTriggersBySlot.slice();
		clone.seed(this._seed);
		clone._parser = this._parser;
		clone._skills = this._skills.slice();
		clone._onSkillActivate = this._onSkillActivate;
		clone._onSkillDeactivate = this._onSkillDeactivate;
		clone._posKeepMode = this._posKeepMode;
		clone._mode = this._mode;
		clone._skillWisdomCheck = this._skillWisdomCheck;
		clone._rushedKakari = this._rushedKakari;
		clone._competeFight = this._competeFight;
		clone._leadCompetition = this._leadCompetition;
		clone._laneMovement = this._laneMovement;
		clone._duelingRates = this._duelingRates;

		// NB. GOTCHA: if asitame is enabled, it closes over *our* horse and mood data, and not the clone's
		// this is assumed to be fine, since fork() is intended to be used after everything is added except skills,
		// but it does mean that if you want to compare different power stats or moods, you must call withAsiwotameru()
		// after fork() on each instance separately, which is a potential gotcha
		clone._extraSkillHooks = this._extraSkillHooks.slice();
		return clone;
	}

	*build() {
		let horse = buildBaseStats(this._horse, this._horse.mood);
		const skillTriggerSeed = this._rng.int32();

		const wholeCourse = new RegionList();
		wholeCourse.push(new Region(0, this._course.distance));
		Object.freeze(wholeCourse);

		const makeSkill = buildSkillData.bind(null, horse, this._raceParams, this._course, wholeCourse, this._parser);
		const skilldata = this._skills.flatMap(({id,p,originWisdom,victimSafe}) => makeSkill(id, p, false, originWisdom, victimSafe));
		this._extraSkillHooks.forEach(h => h(skilldata, horse, this._course));
		const occurrences = new Map<string, number>();
		// HP-7 review-4 (E-I1): victim-safe entries get their own occurrence-count and seed namespace --
		// see the seed derivation below for why.
		const debuffOccurrences = new Map<string, number>();
		// SKL-21: a cooldown skill gets 3 spare candidates (+1 primary = 4 total) -- NOT a race-time
		// guess, but the exact count all_corner_random's own policy already rolls. Per
		// plans/condition-reference/conditions.md:125: "[all_corner_random] randomly picks four
		// points (each time rolls a random corner, and then a random point on that corner). That
		// means that if the skill in question has a short cooldown, there are multiple points where
		// it can activate this way." Spares are only requested for a policy that actually places
		// more than one such point (see samplePolicyPlacesMultiplePoints() above): AllCornerRandomPolicy
		// and the DistributionRandomPolicy family (Uniform/LogNormal/Erlang -- continuously
		// re-evaluated conditions, corroborated by 7 genuine re-triggers observed in real replays).
		// straight_random and is_finalcorner_random (conditions.md:1493 and :675) each document
		// placing exactly one point no matter the course, so they get 0 spares and can never re-arm,
		// matching that documented single-point behavior. Non-cooldown skills pass 0 regardless and
		// draw exactly what they always drew. (Duplicated at :631 for the pacer path --
		// prepPacerTriggers() -- with the same value and the same rationale.)
		// ANCHOR: skl-21-spares-count
		const SPARES = 3;
		const triggers = skilldata.map(sd => {
			const key = sd.perspective != null ? this.getSamplePolicyKey(sd.skillId, sd.perspective) : sd.skillId;
			// HP-7 review-4 (E-I1): count victim-safe occurrences in their own map. `occurrences` above
			// is the shared count `_samplePolicyOverride`'s key space depends on -- addOpponentDebuff's
			// victim-safe entries share that same `${skillId}:${perspective}` key with every other
			// Perspective.Other add path (an opponent's own equipped copy of the same skill,
			// addSkillAtPosition's forced-position override, ...). Counting a victim-safe entry into the
			// shared map, even though its *sample policy* is already protected from the override below,
			// still shifts the `occurrence` number every other same-key entry sees, which in turn shifts
			// their RNG seed -- exactly the "policy half fixed, seed half not" gap review-3 left open.
			const occMap = sd.victimSafe ? debuffOccurrences : occurrences;
			const occurrence = occMap.get(key) || 0;
			occMap.set(key, occurrence + 1);
			// HP-7 review-3 fix 1: `_samplePolicyOverride` is keyed only by `${skillId}:${perspective}`
			// (getSamplePolicyKey), and addSkillAtPosition's forced-position override shares that key
			// with addOpponentDebuff's victim-safe entry for the same skill/perspective pair -- e.g.
			// uma A's own equipped debuff, forced to a position via the always-visible "Force @
			// position" input (addSkillAtPosition(id, pos, Perspective.Other, ...)), and uma B's Stam
			// Debuff dialog configuring the same skill id as an incoming debuff on the same builder
			// (addOpponentDebuff(id), also Perspective.Other) collide on `${id}:Other`. A prior design
			// note claimed setting `samplePolicy` on the returned SkillData already avoided this --
			// wrong: the override map is consulted first and wins regardless of what `sd.samplePolicy`
			// holds. A victim-safe debuff's forced RandomPolicy (buildSkillData) must therefore never
			// be overridable, so it's checked before consulting the map at all -- an unrelated
			// forced-position input silently collapsing every sampled activation of an incoming debuff
			// onto one point would otherwise skew the whole Skill Chart's paired comparison.
			const sp = sd.victimSafe ? sd.samplePolicy : (this._samplePolicyOverride.get(key) || sd.samplePolicy);
			const spares = sd.cooldown != null && samplePolicyPlacesMultiplePoints(sp) ? SPARES : 0;
			// HP-7 review-4 (E-I1): namespace the seed key too, for the same reason as the occurrence
			// map above -- this is the fix for the *seed* half of the collision (see the occurrence-map
			// comment). Only NEW (HP-7) RNG streams move: an entry that isn't victimSafe still seeds
			// from the exact same `${key}:${occurrence}` string as before.
			const seedKey = sd.victimSafe ? `${key}:debuff:${occurrence}` : `${key}:${occurrence}`;
			const flat = sp.sample(sd.regions, this.nsamples, new Rule30CARng(deriveSeed(skillTriggerSeed, seedKey)), spares);
			return {flat, spares};
		});

		// must come after skill activations are decided because conditions like base_power depend on base stats
		horse = buildAdjustedStats(horse, this._course, this._raceParams.groundCondition);

		for (let i = 0; i < this.nsamples; ++i) {
			let solverRng = new Rule30CARng(this._rng.int32());

			const skills = skilldata.map((sd, sdi) => {
				const {flat, spares} = triggers[sdi];
				const n = flat.length / (1 + spares);
				const si = i % n;
				return {
					skillId: sd.skillId,
					perspective: sd.perspective,
					rarity: sd.rarity,
					trigger: flat[si],
					extraCondition: sd.extraCondition,
					effects: sd.effects,
					originWisdom: sd.originWisdom,
					cooldown: sd.cooldown,
					victimSafe: sd.victimSafe,
					spares: spares > 0 ? flat.slice(n + si * spares, n + (si + 1) * spares) : undefined
				};
			});

			const hpRng = new Rule30CARng(this._rng.int32());
			const hpPolicy = this._mode === 'compare' ? new GameHpPolicy(this._course, this._raceParams.groundCondition, hpRng) : NoopHpPolicy;

			const redo: boolean = yield new RaceSolver({
				horse,
				course: this._course,
				skills,
				hp: hpPolicy,
				rng: solverRng,
				onSkillActivate: this._onSkillActivate,
				onSkillDeactivate: this._onSkillDeactivate,
				posKeepMode: this._posKeepMode,
				mode: this._mode,
				skillWisdomCheck: this._skillWisdomCheck,
				rushedKakari: this._rushedKakari,
				competeFight: this._competeFight,
				leadCompetition: this._leadCompetition,
				duelingRates: this._duelingRates,
				laneMovement: this._laneMovement
			});

			if (redo) {
				--i;
			}
		}
	}
}
