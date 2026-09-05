import { strict as assert } from 'node:assert';

import { Strategy, Aptitude, HorseParameters, StrategyHelpers, StrategyProficiencyModifier } from './HorseTypes';
import { CourseData, CourseHelpers, Phase } from './CourseData';
import { Region } from './Region';
import { deriveSeed, PRNG, Rule30CARng } from './Random';
import type { HpPolicy } from './HpPolicy';
import { ApproximateCondition } from './ApproximateConditions';
import { createBlockedSideCondition, createOvertakeCondition } from './SpecialConditions';

// ANCHOR: cc-global-declare-fallback
declare var CC_GLOBAL: boolean

// for the browser builds, CC_GLOBAL is defined by esbuild as true/false
// for node however we have to manually define it as false
// annoyingly we can't use `var` here to define it locally because esbuild rewrites all uses of that to not be
// replaced by the define
// not entirely happy with this solution
if (typeof CC_GLOBAL == "undefined") global.CC_GLOBAL = false;


namespace Speed {
	export const StrategyPhaseCoefficient = Object.freeze([
		[], // strategies start numbered at 1
		[1.0, 0.98, 0.962],
		[0.978, 0.991, 0.975],
		[0.938, 0.998, 0.994],
		[0.931, 1.0, 1.0],
		[1.063, 0.962, 0.95]
	].map(a => Object.freeze(a)));
	export const DistanceProficiencyModifier = Object.freeze([1.05, 1.0, 0.9, 0.8, 0.6, 0.4, 0.2, 0.1]);
}

function baseSpeed(course: CourseData) {
	return 20.0 - (course.distance - 2000) / 1000.0;
}

function baseTargetSpeed(horse: HorseParameters, course: CourseData, phase: Phase) {
	return baseSpeed(course) * Speed.StrategyPhaseCoefficient[horse.strategy][phase] +
		+(phase == 2) * Math.sqrt(500.0 * horse.speed) *
		Speed.DistanceProficiencyModifier[horse.distanceAptitude] *
		0.002;
}

function lastSpurtSpeed(horse: HorseParameters, course: CourseData) {
	let v = (baseTargetSpeed(horse, course, 2) + 0.01 * baseSpeed(course)) * 1.05 +
		Math.sqrt(500.0 * horse.speed) * Speed.DistanceProficiencyModifier[horse.distanceAptitude] * 0.002;
	v += Math.pow(450.0 * horse.guts, 0.597) * 0.0001;
	return v;
}

namespace Acceleration {
	export const StrategyPhaseCoefficient = Object.freeze([
		[],
		[1.0, 1.0, 0.996],
		[0.985, 1.0, 0.996],
		[0.975, 1.0, 1.0],
		[0.945, 1.0, 0.997],
		[1.17, 0.94, 0.956]
	].map(a => Object.freeze(a)));
	export const GroundTypeProficiencyModifier = Object.freeze([1.05, 1.0, 0.9, 0.8, 0.7, 0.5, 0.3, 0.1]);
	export const DistanceProficiencyModifier = Object.freeze([1.0, 1.0, 1.0, 1.0, 1.0, 0.6, 0.5, 0.4]);
}

const BaseAccel = 0.0006;
const UphillBaseAccel = 0.0004;

function baseAccel(baseAccel: number, horse: HorseParameters, phase: Phase) {
	return baseAccel * Math.sqrt(500.0 * horse.power) *
	  Acceleration.StrategyPhaseCoefficient[horse.strategy][phase] *
	  Acceleration.GroundTypeProficiencyModifier[horse.surfaceAptitude] *
	  Acceleration.DistanceProficiencyModifier[horse.distanceAptitude];
}

const PhaseDeceleration = [-1.2, -0.8, -1.0];

namespace PositionKeep {
	export const BaseMinimumThreshold = Object.freeze([0, 0, 3.0, 6.5, 7.5]);
	export const BaseMaximumThreshold = Object.freeze([0, 0, 5.0, 7.0, 8.0]);

	export function courseFactor(distance: number) {
		return 0.0008 * (distance - 1000) + 1.0;
	}

	export function minThreshold(strategy: Strategy, distance: number) {
		// senkou minimum threshold is a constant 3.0 independent of the course factor for some reason
		return BaseMinimumThreshold[strategy] * (strategy == Strategy.Senkou ? 1.0 : courseFactor(distance));
	}

	export function maxThreshold(strategy: Strategy, distance: number) {
		return BaseMaximumThreshold[strategy] * courseFactor(distance);
	}
}

// these are commonly initialized with a negative number and then checked >= 0 to see if a duration is up
// (the reason for doing that instead of initializing with 0 and then checking against the duration is if
// the code that checks for the duration expiring is separate from the code that initializes the timer and
// has to deal with different durations)
export class Timer {
	constructor(public t: number) {}
}

export class CompensatedAccumulator {
	constructor(public acc: number, public err: number = 0.0) {}

	add(n: number) {
		const t = this.acc + n;
		if (Math.abs(this.acc) >= Math.abs(n)) {
			this.err += (this.acc - t) + n;
		} else {
			this.err += (n - t) + this.acc;
		}
		this.acc = t;
	}
}

export interface RaceState {
	readonly accumulatetime: Readonly<Timer>
	readonly activateCount: readonly number[]
	readonly activateCountHeal: number
	readonly activateCountLastFrame: number
	readonly activateCountLaterHalf: number
	readonly currentSpeed: number
	readonly isLastSpurt: boolean
	readonly lastSpurtSpeed: number
	readonly lastSpurtTransition: number
	readonly positionKeepState: PositionKeepState
	readonly isDownhillMode: boolean
	readonly phase: Phase
	readonly pos: number
	readonly hp: Readonly<HpPolicy>
	readonly randomLot: number
	readonly startDelay: number
	readonly gateRoll: number
	readonly usedSkills: ReadonlySet<string>
	readonly leadCompetition: boolean
	readonly posKeepStrategy: Strategy
	readonly isRushed: boolean
	readonly hasBeenRushed: boolean
}

export type DynamicCondition = (state: RaceState) => boolean;

export const enum Perspective {
	Self = 1,
	Other = 2,
	Any = 3
}

export const enum SkillType {
	Noop = 0,
	SpeedUp = 1,
	StaminaUp = 2,
	PowerUp = 3,
	GutsUp = 4,
	WisdomUp = 5,
	// ANCHOR: skill-type-recovery-enum
	Recovery = 9,
	MultiplyStartDelay = 10,
	SetStartDelay = 14,
	CurrentSpeed = 21,
	CurrentSpeedWithNaturalDeceleration = 22,
	TargetSpeed = 27,
	LaneMovementSpeed = 28,
	Accel = 31,
	ChangeLane = 35,
	ActivateRandomGold = 37,
	ExtendEvolvedDuration = 42
}

export const enum SkillRarity { White = 1, Gold, Unique, Evolution = 6 }

export const enum PositionKeepState {
	None = 0,
	PaceUp = 1,
	PaceDown = 2,
	SpeedUp = 3,
	Overtake = 4,
}

export function getPositionKeepStateName(state: PositionKeepState): string {
	switch (state) {
		case PositionKeepState.None: return 'None';
		case PositionKeepState.PaceUp: return 'PaceUp';
		case PositionKeepState.PaceDown: return 'PaceDown';
		case PositionKeepState.SpeedUp: return 'SpeedUp';
		case PositionKeepState.Overtake: return 'Overtake';
		default: return 'Unknown';
	}
}

export const enum PosKeepMode { None, Approximate, Virtual }

export function getPosKeepModeName(mode: PosKeepMode): string {
	switch (mode) {
		case PosKeepMode.None: return 'None';
		case PosKeepMode.Approximate: return 'Approximate';
		case PosKeepMode.Virtual: return 'Virtual';
		default: return 'Unknown';
	}
}

export interface SkillEffect {
	type: SkillType
	baseDuration: number
	modifier: number
	valueUsage?: number
}

export interface PendingSkill {
	skillId: string
	perspective?: Perspective
	rarity: SkillRarity
	trigger: Region
	extraCondition: DynamicCondition
	effects: SkillEffect[]
	originWisdom?: number
}

interface ActiveSkill {
	skillId: string
	perspective?: Perspective
	durationTimer: Timer
	modifier: number
}

function noop(x: unknown) {}

export class RaceSolver {
	accumulatetime: Timer
	pos: number
	minSpeed: number
	currentSpeed: number
	targetSpeed: number
	accel: number
	baseTargetSpeed: number[]
	lastSpurtSpeed: number
	lastSpurtTransition: number
	sectionModifier: number[]
	baseAccel: number[]
	horse: { -readonly[P in keyof HorseParameters]: HorseParameters[P] }
	course: CourseData
	hp: HpPolicy
	rng: PRNG
	syncRng: PRNG
	gorosiRng: PRNG
	rushedRng: PRNG
	downhillRng: PRNG[]
	sectionSpeedRng: PRNG
	skillWisdomSeed: number
	skillValueSeed: number
	posKeepRng: PRNG
	laneMovementRng: PRNG
	specialConditionRng: PRNG
	competeFightRng: PRNG
	timers: Timer[]
	startDash: boolean
	startDelay: number
	startDelayAccumulator: number
	gateRoll: number
	randomLot: number
	isLastSpurt: boolean
	phase: Phase
	nextPhaseTransition: number
	activeTargetSpeedSkills: ActiveSkill[]
	activeCurrentSpeedSkills: (ActiveSkill & {naturalDeceleration: boolean})[]
	activeAccelSkills: ActiveSkill[]
	activeLaneMovementSkills: ActiveSkill[]
	activeChangeLaneSkills: ActiveSkill[]
	pendingSkills: PendingSkill[]
	pendingRemoval: Set<string>
	usedSkills: Set<string>
	nHills: number
	hillIdx: number
	slopePer: number
	hillStart: number[]
	hillEnd: number[]
	activateCount: number[]
	activateCountHeal: number
	// Keyed by `${skillId}:${perspective}`; counts prior activations of that skill from that
	// perspective so a repeat activation (e.g. the replay direct-position-pinning path's
	// double-fire, see README's "Skill cooldowns" caveat) draws an independent value-scaling
	// roll instead of reusing the first activation's. See scaleEffectValue().
	skillActivationCounts: Map<string, number>
	activateCountLastFrame: number
	activateCountThisFrame: number
	activateCountLaterHalf: number
	onSkillActivate: (s: RaceSolver, skillId: string, perspective: Perspective) => void
	onSkillDeactivate: (s: RaceSolver, skillId: string, perspective: Perspective) => void
	sectionLength: number
	// ANCHOR: umas-field-declaration
	umas: RaceSolver[]
	isPacer: boolean
	pacerOverride: boolean
	posKeepMinThreshold: number
	posKeepMaxThreshold: number
	posKeepCooldown: Timer
	posKeepNextTimer: Timer
	posKeepExitPosition: number;
	posKeepExitDistance: number;
	posKeepEnd: number
	positionKeepState: PositionKeepState
	posKeepMode: PosKeepMode
	posKeepSpeedCoef: number
	posKeepStrategy: Strategy
	mode: string | undefined
	pacer: RaceSolver | null
	skillWisdomCheck: boolean
	rushedKakari: boolean

	// Rushed state
	isRushed: boolean
	hasBeenRushed: boolean  // Track if horse has already been rushed this race (can only happen once)
	rushedSection: number  // Which section (2-9) the rushed state activates in
	rushedEnterPosition: number  // Position where rushed state should activate
	rushedTimer: Timer  // Tracks time in rushed state
	rushedMaxDuration: number  // Maximum duration (12s + extensions)
	rushedEscapeRolls: number  // How many of the 3 escape rolls (at 3s/6s/9s) have been taken
	rushedActivations: Array<[number, number]>  // Track [start, end] positions for UI
	positionKeepActivations: Array<[number, number, PositionKeepState]>  // Track [start, end, state] positions for UI

	speedUpProbability: number  // 0-100, probability of entering speed-up mode
	
	//downhill mode
	isDownhillMode: boolean
	downhillTimer: Timer
	downhillActivations: Array<[number, number]>

	// Compete Fight
	canCompeteFight: boolean | null
	competeFight: boolean
	competeFightStart: number | null
	competeFightEnd: number | null
	competeFightTimer: Timer
	competeFightEnabled: boolean
	duelingRates: {
		runaway: number,
		frontRunner: number,
		paceChaser: number,
		lateSurger: number,
		endCloser: number
	} | null

	// Lead Competition
	leadCompetitionEnabled: boolean
	leadCompetition: boolean
	leadCompetitionStart: number | null
	leadCompetitionEnd: number | null
	leadCompetitionDistanceExited: boolean
	leadCompetitionTimer: Timer
	
	// lane movement..........
	laneMovementEnabled: boolean
	currentLane: number
    targetLane: number
    laneChangeSpeed: number
    extraMoveLane: number
    // ANCHOR: force-in-speed-field
    forceInSpeed: number

	firstUmaInLateRace: boolean

	hpDied: boolean
	hpDiedPosition: number | null
	fullSpurt: boolean
	nonFullSpurtVelocityDiff: number | null
	nonFullSpurtDelayDistance: number | null

	modifiers: {
		targetSpeed: CompensatedAccumulator
		currentSpeed: CompensatedAccumulator
		accel: CompensatedAccumulator
		oneFrameAccel: number
		specialSkillDurationScaling: number
	}

	private conditionTimer: Timer
	private conditionValues: Map<string, number> = new Map()
	private conditions: Map<string, ApproximateCondition> = new Map()

	constructor(params: {
		horse: HorseParameters,
		course: CourseData,
		rng: PRNG,
		skills: PendingSkill[],
		hp: HpPolicy,
		onSkillActivate?: (s: RaceSolver, skillId: string) => void,
		onSkillDeactivate?: (s: RaceSolver, skillId: string) => void,
		speedUpProbability?: number,
		posKeepMode?: PosKeepMode,
		mode?: string,
		isPacer?: boolean,
		skillWisdomCheck?: boolean,
		rushedKakari?: boolean,
		competeFight?: boolean,
		leadCompetition?: boolean,
		duelingRates?: {
			runaway: number,
			frontRunner: number,
			paceChaser: number,
			lateSurger: number,
			endCloser: number
		},
		laneMovement?: boolean,
	}) {
		// clone since green skills may modify the stat values
		// ANCHOR: solver-horse-clone
		this.horse = Object.assign({}, params.horse);
		this.course = params.course;
		this.hp = params.hp;
		this.rng = params.rng;
		this.pendingSkills = params.skills.slice();  // copy since we remove from it
		this.pendingRemoval = new Set();
		this.usedSkills = new Set();
		this.skillActivationCounts = new Map();
		this.syncRng = new Rule30CARng(this.rng.int32());
		this.gorosiRng = new Rule30CARng(this.rng.int32());
		this.rushedRng = new Rule30CARng(this.rng.int32());
		const wisdomSeed = this.rng.int32();
		this.sectionSpeedRng = new Rule30CARng(wisdomSeed);
		this.skillWisdomSeed = deriveSeed(wisdomSeed, 'skill-wisdom');
		this.skillValueSeed = deriveSeed(wisdomSeed, 'skill-value');
		this.posKeepRng = new Rule30CARng(this.rng.int32());
		this.laneMovementRng = new Rule30CARng(this.rng.int32());
		this.specialConditionRng = new Rule30CARng(this.rng.int32());
		this.competeFightRng = new Rule30CARng(this.rng.int32());
		this.timers = [];
		this.conditionTimer = this.getNewTimer(-1.0);
		this.accumulatetime = this.getNewTimer();
		// bit of a hack because implementing post_number is surprisingly annoying, since we don't have RaceParameters.numUmas available here
		// and can't draw random numbers in the conditions. instead what we do is draw a random number here that decides the gate, and then
		// in the post_number dynamic condition we mod that by the number of umas to figure out our starting position, and then figure out
		// which gate block that is in. however, n%k is not in general uniformly distributed for a random n, and we can't/don't want to instantiate
		// a new rng instance in the dynamic condition for rejection sampling. fortunately n%k IS uniformly distributed when n_max ≡ k - 1 (mod k)
		// the smallest n_max where that is true for every k in [1,18] is lcm(1, 2, … 18) - 1 (n_max ≡ k-1 (mod k) means k divides n_max+1. the
		// smallest n_max where this is true for every k = 1, 2, … 18 is lcm(1, 2, … 18) - 1), which is 12252239. since PRNG#uniform excludes its
		// upper bound, just generate up to lcm(1, 2, … 18) = 12252240
		this.gateRoll = this.rng.uniform(12252240);
		this.randomLot = this.rng.uniform(100);
		this.phase = 0;
		this.nextPhaseTransition = CourseHelpers.phaseStart(this.course.distance, 1);
		this.activeTargetSpeedSkills = [];
		this.activeCurrentSpeedSkills = [];
		this.activeAccelSkills = [];
		this.activeLaneMovementSkills = [];
		this.activeChangeLaneSkills = [];
		this.activateCount = [0,0,0];
		this.activateCountHeal = 0;
		this.activateCountLastFrame = 0;
		this.activateCountThisFrame = 0;
		this.activateCountLaterHalf = 0;
		this.onSkillActivate = params.onSkillActivate || noop;
		this.onSkillDeactivate = params.onSkillDeactivate || noop;
		this.sectionLength = this.course.distance / 24.0;
		this.posKeepMinThreshold = PositionKeep.minThreshold(this.horse.strategy, this.course.distance);
		this.posKeepMaxThreshold = PositionKeep.maxThreshold(this.horse.strategy, this.course.distance);
		this.posKeepNextTimer = this.getNewTimer();
		this.positionKeepState = PositionKeepState.None;
		this.posKeepMode = params.posKeepMode || PosKeepMode.None;
		this.posKeepStrategy = this.horse.strategy;
		this.mode = params.mode;
		this.skillWisdomCheck = params.skillWisdomCheck !== false;
		this.rushedKakari = params.rushedKakari !== false;
		// For skill chart we want to minimize poskeep skewing results
		// (i.e. in rare situations, an uma can proc a velocity skill, and gain initial positioning
		// but then lose that positioning because they are too far forward to proc Pace Up)
		// this then results in -L in the charts
		this.posKeepEnd = this.sectionLength * (this.mode === 'compare' ? 10.0 : 3.0);
		this.posKeepSpeedCoef = 1.0;
		this.isPacer = params.isPacer || false;
		this.pacerOverride = false;
		this.umas = [];
		this.pacer = null;

		//init timer
		this.speedUpProbability = params.speedUpProbability != null ? params.speedUpProbability : 100
		
		// Initialize rushed state
		this.isRushed = false;
		this.hasBeenRushed = false;
		this.rushedSection = -1;
		this.rushedEnterPosition = -1;
		this.rushedTimer = this.getNewTimer();
		// ANCHOR: rushed-max-duration-init
		this.rushedMaxDuration = 12.0;
		this.rushedEscapeRolls = 0;

		// Initialize downhill mode
		this.isDownhillMode = false;
		this.downhillActivations = [];
		
		// Initialize skill check chance
		this.rushedActivations = [];
		this.positionKeepActivations = [];
		this.firstUmaInLateRace = false;
		this.hpDied = false;
		this.hpDiedPosition = null;
		this.fullSpurt = false;
		this.nonFullSpurtVelocityDiff = null;
		this.nonFullSpurtDelayDistance = null;
		// Calculate rushed chance and determine if/when it activates
		if (this.rushedKakari) {
			// ANCHOR: init-rushed-state-call
			this.initRushedState();
		}

		this.competeFightEnabled = params.competeFight !== false;
		this.duelingRates = params.duelingRates || null;
		this.canCompeteFight = null;
		this.competeFight = false;
		this.competeFightStart = null;
		this.competeFightEnd = null;
		this.competeFightTimer = this.getNewTimer();

		this.leadCompetitionEnabled = params.leadCompetition !== false;
		this.leadCompetition = false;
		this.leadCompetitionStart = null;
		this.leadCompetitionEnd = null;
		this.leadCompetitionDistanceExited = false;
		this.leadCompetitionTimer = this.getNewTimer();

		this.laneMovementEnabled = params.laneMovement !== false;

		const gateNumberRaw = this.gateRoll % 9;
		const gateNumber = gateNumberRaw < 9 ? gateNumberRaw : 1 + (24 - gateNumberRaw) % 8;
		const initialLane = gateNumber * this.course.horseLane;

		this.currentLane = initialLane;
		this.targetLane = initialLane;
		this.laneChangeSpeed = 0.0;
		this.extraMoveLane = -1.0;
		// ANCHOR: force-in-speed-init
		this.forceInSpeed = 0.0;

		this.modifiers = {
			targetSpeed: new CompensatedAccumulator(0.0),
			currentSpeed: new CompensatedAccumulator(0.0),
			accel: new CompensatedAccumulator(0.0),
			oneFrameAccel: 0.0,
			specialSkillDurationScaling: 1.0
		};

		this.startDelay = 0.1 * this.rng.random();

		this.pos = 0.0;
		this.accel = 0.0;
		this.currentSpeed = 3.0;
		this.targetSpeed = 0.85 * baseSpeed(this.course);
		this.processSkillActivations();  // activate gate skills (must come before setting minimum speed because green skills can modify guts)
		this.minSpeed = 0.85 * baseSpeed(this.course) + Math.sqrt(200.0 * this.horse.guts) * 0.001;
		this.startDash = true;
		this.modifiers.accel.add(24.0);  // start dash accel

		this.initHills();

		this.startDelayAccumulator = this.startDelay;

		// similarly this must also come after the first round of skill activations
		this.baseTargetSpeed = ([0,1,2] as Phase[]).map(phase => baseTargetSpeed(this.horse, this.course, phase));
		this.lastSpurtSpeed = lastSpurtSpeed(this.horse, this.course);
		this.lastSpurtTransition = -1;

		this.sectionModifier = Array.from({length: 24}, () => {
			// ANCHOR: section-randomness-wisdom-term
			const max = this.horse.wisdom / 5500.0 * Math.log10(this.horse.wisdom * 0.1);
			const factor = (max - 0.65 + this.sectionSpeedRng.random() * 0.65) / 100.0;
			return baseSpeed(this.course) * factor;
		});
		this.sectionModifier.push(0.0);  // last tick after the race is done, or in a comparison in case one uma runs off the end of the track

		// ANCHOR: hp-init-call
		this.hp.init(this.horse);

		this.baseAccel = ([0,1,2,0,1,2] as Phase[]).map((phase,i) => baseAccel(i > 2 ? UphillBaseAccel : BaseAccel, this.horse, phase));

		this.registerCondition("blocked_side", createBlockedSideCondition());
		this.registerCondition("overtake", createOvertakeCondition());
	}

	initUmas(umas: RaceSolver[]) {
		this.umas = [...umas.filter(uma => uma != null), this];
	}

	initHills() {
		// note that slopes are not always sorted by start location in course_data.json
		// sometimes (?) they are sorted by hill type and then by start
		// require this here because the code relies on encountering them sequentially
		assert(CourseHelpers.isSortedByStart(this.course.slopes), 'slopes must be sorted by start location');

		this.nHills = this.course.slopes.length;
		this.hillStart = this.course.slopes.map(s => s.start).reverse();
		this.hillEnd = this.course.slopes.map(s => s.start + s.length).reverse();
		this.hillIdx = -1;

		this.downhillRng = this.course.slopes.map(_ => new Rule30CARng(this.rng.int32()));
		this.downhillTimer = this.getNewTimer();
		
		if (this.hillStart.length > 0 && this.hillStart[this.hillStart.length - 1] == 0) {
			this.hillIdx = 0;
			// ANCHOR: slope-per-init
			this.slopePer = this.course.slopes[0].slope;
			this.downhillTimer.t = 0;
			this.downhillCheck(this.downhillRng[0].random());
			this.hillStart.pop();
		} else {
			this.slopePer = 0;
		}
	}

	getNewTimer(t: number = 0) {
		const tm = new Timer(t);
		this.timers.push(tm);
		return tm;
	}
	
	initRushedState() {
		// Calculate rushed chance based on wisdom
		// Formula: RushedChance = (6.5 / log10(0.1 * WizStat + 1))²%
		const wisdomStat = this.horse.wisdom;
		const rushedChance = Math.pow(6.5 / Math.log10(0.1 * wisdomStat + 1), 2) / 100;

		// ANCHOR: self-control-rushed-chance-exception
		// Check if horse has 自制心 (Self-Control) skill - ID 202161
		// This reduces rushed chance by flat 3%
		const hasSelfControl = this.pendingSkills.some(s => s.skillId === '202161');
		const finalRushedChance = Math.max(0, rushedChance - (hasSelfControl ? 0.03 : 0));

		// Roll for rushed state
		if (this.rushedRng.random() < finalRushedChance) {
			// ANCHOR: rushed-section-roll
			// Determine which section (2-9) the rushed state activates in
			this.rushedSection = 2 + this.rushedRng.uniform(8);  // Random int from 2 to 9
			this.rushedEnterPosition = this.sectionLength * this.rushedSection;
		}
	}
	
	updateRushedState() {
		// Check if we should enter rushed state (can only happen once per race)
		if (this.rushedSection >= 0 && !this.isRushed && !this.hasBeenRushed && this.pos >= this.rushedEnterPosition) {
			this.isRushed = true;
			this.hasBeenRushed = true;  // Mark that this horse has been rushed
			this.rushedTimer.t = 0;
			this.rushedEscapeRolls = 0;
			this.rushedActivations.push([this.pos, -1]);  // Start tracking, end will be filled later
		}

		// Update rushed state if active
		if (this.isRushed) {
			// The game grants an escape roll at each 3s boundary (3s, 6s, 9s) and force-ends the
			// state at 12s -- three rolls total, no roll at the cap. Counting the rolls taken keeps
			// this independent of the timestep: the old check compared against a hardcoded 1/60s
			// epsilon while every caller steps at 1/15s, which silently dropped the 6s and 9s rolls
			// entirely (see DYN-11). Refs: mee1080/umasim RaceCalculator.kt:245-263;
			// alpha123/uma-skill-tools RaceSolver.ts:348-359.
			while (this.rushedEscapeRolls < 3 && this.rushedTimer.t >= 3 * (this.rushedEscapeRolls + 1)) {
				this.rushedEscapeRolls++;
				// 55% chance to snap out of it
				if (this.rushedRng.random() < 0.55) {
					this.endRushedState();
					return;
				}
			}

			// Force end after max duration
			if (this.rushedTimer.t >= this.rushedMaxDuration) {
				this.endRushedState();
			}
		}
	}
	
	endRushedState() {
		this.isRushed = false;
		// Mark the end position for UI display
		if (this.rushedActivations.length > 0) {
			const lastIdx = this.rushedActivations.length - 1;
			if (this.rushedActivations[lastIdx][1] === -1) {
				this.rushedActivations[lastIdx][1] = this.pos;
			}
		}
	}

	getMaxStartDashSpeed() {
		return Math.min(this.targetSpeed, 0.85 * baseSpeed(this.course));
	}

	logVelocityData(dt: number) {
		console.log('frame: ', this.accumulatetime.t);
		console.log('current speed: ', this.currentSpeed);
		console.log('accel: ', this.accel);
		console.log('dist:', this.pos);
		console.log('--------------------------------');
	}

	step(dt: number) {
		let dtAfterDelay = dt

		this.timers.forEach(tm => tm.t += dt);

		if (this.conditionTimer.t >= 0.0) {
			this.tickConditions();
			this.conditionTimer.t = -1.0;
		}

		if (this.startDelayAccumulator > 0.0) {
			this.startDelayAccumulator -= dt;

			if (this.startDelayAccumulator > 0.0) {
				return;
			}
		}
		
		this.updateHills();
		// ANCHOR: update-phase-call-in-step
		this.updatePhase();
		this.updateRushedState();
		this.processSkillActivations();
		this.applyPositionKeepStates();
		this.updatePositionKeepCoefficient();
		this.updateCompeteFight();
		// ANCHOR: lead-competition-check-in-step
		this.updateLeadCompetition();
		this.updateLastSpurtState();
		this.updateTargetSpeed();
		this.applyForces();
		if (this.laneMovementEnabled) {
			this.applyLaneMovement();
		}

		let newSpeed = undefined;

		if (this.currentSpeed <= this.targetSpeed) {
			newSpeed = Math.min(this.currentSpeed + this.accel * dt, this.targetSpeed);
		}
		else {
			newSpeed = Math.max(this.currentSpeed + this.accel * dt, this.targetSpeed);
		}

		if (this.startDash && newSpeed > this.getMaxStartDashSpeed()) {
			newSpeed = this.getMaxStartDashSpeed();
		}
		
		if (!this.startDash && this.currentSpeed < this.minSpeed) {
			newSpeed = this.minSpeed;
		}

		this.currentSpeed = newSpeed;

		const displacement = this.currentSpeed + this.modifiers.currentSpeed.acc + this.modifiers.currentSpeed.err;

		if (this.startDelayAccumulator < 0.0) {
			dtAfterDelay = Math.abs(this.startDelayAccumulator);
			this.startDelayAccumulator = 0.0;
		}

		// ANCHOR: position-update-in-step
		this.pos += displacement * dtAfterDelay;
		this.hp.tick(this, dt);

		if (!this.hp.hasRemainingHp() && !this.hpDied) {
			this.hpDied = true;
			this.hpDiedPosition = this.course.distance - this.pos;
		}

		if (this.startDash && this.currentSpeed >= 0.85 * baseSpeed(this.course)) {
			this.startDash = false;
			this.modifiers.accel.add(-24.0);
		}

		this.modifiers.oneFrameAccel = 0.0;
	}

	applyLaneMovement() {
		const currentLane = this.currentLane
		const sideBlocked = this.getConditionValue("blocked_side") === 1;
		const overtake = this.getConditionValue("overtake") === 1;

		// ANCHOR: extra-move-lane-formula
		if (this.extraMoveLane < 0.0 && this.isAfterFinalCornerOrInFinalStraight()) {
			this.extraMoveLane = Math.min(currentLane / 0.1, this.course.maxLaneDistance) * 0.5 + (this.laneMovementRng.random() * 0.1);
		}

		if (this.activeChangeLaneSkills.length > 0) {
			this.targetLane = 9.5 * this.course.horseLane;
		}
		else if (overtake) {
			this.targetLane = Math.max(this.targetLane, this.course.horseLane, this.extraMoveLane);
		}
		else if (!this.hp.hasRemainingHp()) {
			this.targetLane = currentLane;
		}
		else if (this.positionKeepState === PositionKeepState.PaceDown) {
			this.targetLane = 0.18;
		}
		else if (this.extraMoveLane > currentLane) {
			this.targetLane = this.extraMoveLane;
		}
		else if (this.phase <= 1 && !sideBlocked) {
			this.targetLane = Math.max(0.0, currentLane - 0.05);
		}
		else {
			this.targetLane = currentLane;
		}

		if ((sideBlocked && this.targetLane < currentLane) || Math.abs(this.targetLane - currentLane) < 0.00001) {
			this.laneChangeSpeed = 0.0
		} else {
			let targetSpeed = 0.02 * (0.3 + 0.001 * this.horse.power);

			if (this.pos < this.course.moveLanePoint) {
				targetSpeed *= (1 + currentLane / this.course.maxLaneDistance * 0.05);
			}

			this.laneChangeSpeed = Math.min(this.laneChangeSpeed + this.course.laneChangeAccelerationPerFrame, targetSpeed);

			let actualSpeed = Math.min(this.laneChangeSpeed + this.activeLaneMovementSkills.reduce((sum, skill) => sum + skill.modifier, 0), 0.6);
			
			if (this.targetLane > currentLane) {
				this.currentLane = Math.min(this.targetLane, currentLane + actualSpeed);
			} else {
				this.currentLane = Math.max(this.targetLane, currentLane - actualSpeed * (1.0 + currentLane));
			}
		}
	}

	// Slightly scuffed way of ensuring all umas use the same pacemaker
	// in compare.ts, call .getPacer() on any uma (doesn't matter which)
	// and then call .updatePacer(result) on all umas to update pacer reference
	updatePacer(pacemaker: RaceSolver) {
		this.pacer = pacemaker;
	}

	// Furthest-forward (highest .pos) uma in a non-empty group. Shared by getPacer()'s two
	// "pick the leader of this style group" lookups and tryStartLeadCompetition()'s frontmost-uma
	// reference (see work-queue DYN-14) -- all three were the same reduce written out separately.
	// Static (not this.<method>) so it stays callable via RaceSolver.prototype.<method>.call(stub)
	// in the mechanics-test stubs (test/RaceSolverTestHelpers.ts's attachMethods) without needing
	// to be attached as a sibling method itself.
	static frontmostByPos<T extends {pos: number}>(umas: T[]): T {
		return umas.reduce((max, uma) => uma.pos > max.pos ? uma : max, umas[0]);
	}

	getPacer(): RaceSolver | null {
		// Select furthest-forward front runner
		// ANCHOR: umas-filter-by-strategy-equality
		for (const strategy of [Strategy.Oonige, Strategy.Nige]) {
			var umas = this.umas.filter(uma => uma.posKeepStrategy === strategy);

			if (umas.length > 0) {
				return RaceSolver.frontmostByPos(umas);
			}
		}

		// Get pacerOverride uma
		var pacerOverrideUma = this.umas.find(uma => uma.pacerOverride);

		if (pacerOverrideUma) {
			return pacerOverrideUma;
		}

		// Otherwise, lucky pace (set pacerOverride)
		// ANCHOR: umas-filter-by-strategy-matches
		for (const strategy of [Strategy.Senkou, Strategy.Sasi, Strategy.Oikomi]) {
			var umas = this.umas.filter(uma => StrategyHelpers.strategyMatches(uma.posKeepStrategy, strategy));

			if (umas.length > 0) {
				var uma = RaceSolver.frontmostByPos(umas);

				uma.pacerOverride = true;
				// ANCHOR: pacer-promotion-nige
				uma.posKeepStrategy = Strategy.Nige;

				return uma;
			}
		}

		// Otherwise, get virtual pacemaker
		// (this should never happen though)
		var pacer = this.umas.find(uma => uma.isPacer);

		if (pacer) {
			// ANCHOR: virtual-pacemaker-nige
			pacer.posKeepStrategy = Strategy.Nige;
			return pacer;
		}
	}

	getUmaByDistanceDescending(): RaceSolver[] {
		return this.umas.sort((a, b) => b.pos - a.pos);
	}

	isOnlyFrontRunner(): boolean {
		// ANCHOR: front-runners-filter
		var frontRunners = this.umas.filter(uma => StrategyHelpers.strategyMatches(uma.posKeepStrategy, Strategy.Nige));
		return frontRunners.length === 1 && frontRunners[0] === this;
	}

	// In Virtual Pacemaker mode, we care about the effects of position keep and the way
	// umas react during poskeep based on their wit
	//
	// In Approximate mode, we don't really care about poskeep - it's just a way to give out
	// PDM/PUM early-race to mimic what actually happens in game so we limit poskeep to 5 sections
	// and use synced rng to make skill comparison possible.
	speedUpOvertakeWitCheck(): boolean {
		return this.posKeepRng.random() < 0.2 * Math.log10(0.1 * this.horse.wisdom);
	}

	paceUpWitCheck(): boolean {
		return this.posKeepRng.random() < 0.15 * Math.log10(0.1 * this.horse.wisdom);
	}

	applyPositionKeepStates() {
		if (this.pos >= this.posKeepEnd || this.posKeepMode === PosKeepMode.None) {
			// State change triggered by poskeep end
			if (this.positionKeepState !== PositionKeepState.None && this.positionKeepActivations.length > 0) {
				this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
			}

			this.positionKeepState = PositionKeepState.None;
			return;
		}

		if (!this.pacer) {
			return;
		}

		var pacer = this.pacer;
		var behind = pacer.pos - this.pos;
		var myStrategy = this.posKeepStrategy;

		switch (this.positionKeepState) {
			case PositionKeepState.None:
				if (this.posKeepNextTimer.t < 0) { return; }

				if (StrategyHelpers.strategyMatches(myStrategy, Strategy.Nige)) {
					// Speed Up
					if (pacer === this) {
						var umas = this.getUmaByDistanceDescending();
						var secondPlaceUma = umas[1];
						var distanceAhead = pacer.pos - secondPlaceUma.pos;
						// ANCHOR: speed-up-poskeep-entry-threshold
						let threshold = myStrategy === Strategy.Oonige ? 17.5 : 4.5;

						if (this.posKeepNextTimer.t < 0) { return; }

						if (distanceAhead < threshold && this.speedUpOvertakeWitCheck()) {
							this.positionKeepActivations.push([this.pos, 0, PositionKeepState.SpeedUp]);
							this.positionKeepState = PositionKeepState.SpeedUp;
							this.posKeepExitPosition = this.pos + Math.floor(this.sectionLength);
						}
					}
					// Overtake
					else if (this.speedUpOvertakeWitCheck()) {
						this.positionKeepState = PositionKeepState.Overtake;
						this.positionKeepActivations.push([this.pos, 0, PositionKeepState.Overtake]);
					}
				}
				else {
					// Pace Up
					if (behind > this.posKeepMaxThreshold) {
						if (this.paceUpWitCheck()) {
							this.positionKeepState = PositionKeepState.PaceUp;
							this.positionKeepActivations.push([this.pos, 0, PositionKeepState.PaceUp]);
							this.posKeepExitDistance = this.posKeepRng.random() * (this.posKeepMaxThreshold - this.posKeepMinThreshold) + this.posKeepMinThreshold;
						}
					}
					// Pace Down
					else if (behind < this.posKeepMinThreshold) {
						if (this.activeTargetSpeedSkills.length == 0 && this.activeCurrentSpeedSkills.length == 0) {
							this.positionKeepState = PositionKeepState.PaceDown;
							this.positionKeepActivations.push([this.pos, 0, PositionKeepState.PaceDown]);
							// after 1.5 anniversary, the exit-roll max is replaced with lerp(min,max,0.5) in mid-race
							const paceDownMax = this.phase == 1 ? this.posKeepMinThreshold + 0.5 * (this.posKeepMaxThreshold - this.posKeepMinThreshold) : this.posKeepMaxThreshold;
							this.posKeepExitDistance = this.posKeepRng.random() * (paceDownMax - this.posKeepMinThreshold) + this.posKeepMinThreshold;
						}
					}
				}

				if (this.positionKeepState == PositionKeepState.None) {
					// console.log(this.pos, "Position keep state is None");
					this.posKeepNextTimer.t = -2;
				}
				else {
					// console.log(this.pos, "Position keep state is", getPositionKeepStateName(this.positionKeepState));
					this.posKeepExitPosition = this.pos + Math.floor(this.sectionLength);
				}

				break;
			case PositionKeepState.SpeedUp:
				if (this.pos >= this.posKeepExitPosition) {
					this.positionKeepState = PositionKeepState.None;
					this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
					this.posKeepNextTimer.t = -3;
				}
				else if (pacer == this) {
					var umas = this.getUmaByDistanceDescending();
					var secondPlaceUma = umas[1];
					var distanceAhead = pacer.pos - secondPlaceUma.pos;
					// ANCHOR: speed-up-poskeep-exit-threshold
					let threshold = myStrategy === Strategy.Oonige ? 17.5 : 4.5;

					if (distanceAhead >= threshold) {
						this.positionKeepState = PositionKeepState.None;
						this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
						this.posKeepNextTimer.t = -3;
					}
				}

				break;
			case PositionKeepState.Overtake:
				if (this.pos >= this.posKeepExitPosition) {
					this.positionKeepState = PositionKeepState.None;
					this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
					this.posKeepNextTimer.t = -3;
				}
				else if (pacer == this) {
					var umas = this.getUmaByDistanceDescending();
					var secondPlaceUma = umas[1];
					var distanceAhead = this.pos - secondPlaceUma.pos;
					let threshold = myStrategy === Strategy.Oonige ? 27.5 : 10;

					if (distanceAhead >= threshold) {
						this.positionKeepState = PositionKeepState.None;
						this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
						this.posKeepNextTimer.t = -3;
					}
				}

				break;
			case PositionKeepState.PaceUp:
				if (this.pos >= this.posKeepExitPosition) {
					this.positionKeepState = PositionKeepState.None;
					this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
					this.posKeepNextTimer.t = -3;
				}
				else {
					if (behind < this.posKeepExitDistance) {
						this.positionKeepState = PositionKeepState.None;
						this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
						this.posKeepNextTimer.t = -3;
					}
				}

				break;
			case PositionKeepState.PaceDown:
				if (this.pos >= this.posKeepExitPosition) {
					this.positionKeepState = PositionKeepState.None;
					this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
					this.posKeepNextTimer.t = -3;
				}
				else {
					if (behind > this.posKeepExitDistance || this.activeTargetSpeedSkills.length > 0 || this.activeCurrentSpeedSkills.length > 0) {
						this.positionKeepState = PositionKeepState.None;
						this.positionKeepActivations[this.positionKeepActivations.length - 1][1] = this.pos;
						this.posKeepNextTimer.t = -3;
					}
				}

				break;
			default:
				break;
		}
	}

	updatePositionKeepCoefficient() {
		switch (this.positionKeepState) {
			case PositionKeepState.SpeedUp:
				this.posKeepSpeedCoef = 1.04;
				break;
			case PositionKeepState.Overtake:
				this.posKeepSpeedCoef = 1.05;
				break;
			case PositionKeepState.PaceUp:
				this.posKeepSpeedCoef = 1.04;
				break;
			case PositionKeepState.PaceDown:
				this.posKeepSpeedCoef = this.phase == 1 ? 0.945 : 0.915;
				break;
			default:
				this.posKeepSpeedCoef = 1.0;
				break;
		}
	}
		
	isOnFinalStraight() {
		const lastStraight = this.course.straights[this.course.straights.length - 1];
		return this.pos >= lastStraight.start && this.pos <= lastStraight.end;
	}

	isAfterFinalCorner() {
		const finalCornerStart = this.course.corners.length > 0 ? this.course.corners[this.course.corners.length - 1].start : Infinity;
		return this.pos >= finalCornerStart;
	}

	isAfterFinalCornerOrInFinalStraight() {
		return this.isAfterFinalCorner() || this.isOnFinalStraight();
	}

	updateCompeteFight() {
		if (!this.competeFightEnabled) {
			return;
		}
		
		if (this.competeFight) {
			// ANCHOR: duel-exit-hp-gate
			if (this.hp.hpRatioRemaining() <= 0.05) {
				this.competeFight = false;
				this.competeFightEnd = this.pos;
			}

			return;
		}

		if (StrategyHelpers.strategyMatches(this.posKeepStrategy, Strategy.Nige)) {
			return;
		}

		// ANCHOR: duel-entry-hp-gate
		if (this.hp.hpRatioRemaining() < 0.15 || !this.isOnFinalStraight()) {
			return;
		}

		if (this.canCompeteFight === null) {
			if (this.duelingRates) {
				let rate = 0;
				if (this.posKeepStrategy === Strategy.Oonige) {
					rate = this.duelingRates.runaway;
				} else if (this.posKeepStrategy === Strategy.Nige) {
					rate = this.duelingRates.frontRunner;
				} else if (this.posKeepStrategy === Strategy.Senkou) {
					rate = this.duelingRates.paceChaser;
				} else if (this.posKeepStrategy === Strategy.Sasi) {
					rate = this.duelingRates.lateSurger;
				} else if (this.posKeepStrategy === Strategy.Oikomi) {
					rate = this.duelingRates.endCloser;
				}
				
				this.canCompeteFight = this.competeFightRng.random() < (rate / 100);
				this.competeFightTimer.t = 0;
			} else {
				this.canCompeteFight = false;
			}
		}

		if (!this.canCompeteFight) {
			return;
		}

		if (this.competeFightTimer.t >= 1) {
			if (this.competeFightRng.random() <= 0.4) {
				this.competeFight = true;
				this.competeFightStart = this.pos;
			}
			else {
				this.competeFightTimer.t = 0;
			}
		}
	}

	updateLeadCompetition() {
		if (!this.leadCompetitionEnabled) {
			return;
		}

		if (this.leadCompetitionStart !== null) {
			this.updateLeadCompetitionExit();
			return;
		}

		this.tryStartLeadCompetition();
	}

	// Exit side, for an uma who is already in (or has already been through) a spot struggle.
	// The duration/section-9 cap is checked first, and only a struggler who survives it is tested
	// against the DistanceGap2/LaneGap2 exit -- an uma who times out naturally must NOT be marked
	// as having distance-exited, because the last-struggler cascade below keys off exactly that
	// distinction (see work-queue DYN-14).
	updateLeadCompetitionExit() {
		if (!this.leadCompetition) {
			return;
		}

		// Every exit path below records the same three fields the same way -- only whether it
		// counts as a DistanceGap2/LaneGap2 exit (for the cascade rule further down) differs.
		const exitLeadCompetition = (distanceExited: boolean) => {
			this.leadCompetition = false;
			this.leadCompetitionDistanceExited = distanceExited;
			this.leadCompetitionEnd = this.pos;
		};

		// Duration is scaled by the runner's strategy-aptitude rank (game's CompeteTop
		// parameter block; confirmed empirically by hakuraku.moe/notes/spot-struggle's
		// replay-frame analysis -- see work-queue DYN-8). this.horse.strategyAptitude is
		// read unconditionally, even when posKeepStrategy was reassigned to Nige at runtime
		// (promoted pacer / virtual pacemaker, see updateRace() around :835/:846): the
		// engine only has one scalar aptitude per horse, not a per-strategy table, so there
		// is no better value available -- torena-sim's independent implementation makes the
		// same simplification (self.aptitudes.strategy, a single scalar).
		// ANCHOR: spot-struggle-duration
		let leadCompeteDuration = Math.pow(700 * this.horse.guts, 0.5) * 0.012 * StrategyProficiencyModifier[this.horse.strategyAptitude];

		// leadCompetitionEnd is EndSection: 9, i.e. the absolute position where section 9 starts,
		// shared by the whole group -- not an offset from where this uma personally triggered
		// (see work-queue DYN-14).
		if (this.leadCompetitionTimer.t >= leadCompeteDuration || this.pos >= this.leadCompetitionEnd) {
			exitLeadCompetition(false);
			return;
		}

		// DistanceGap2 / LaneGap2: an active struggler drops out once she is at least 5m behind
		// (or 0.416 course widths to the side of) EVERY other struggler of her style who is still
		// active. Umas who have already left stay in `participants` because the cascade rule below
		// needs to know how they left.
		let participants = this.umas.filter(u => u !== this && u.posKeepStrategy === this.posKeepStrategy && u.leadCompetitionStart !== null);

		if (participants.length === 0) {
			return;
		}

		let activeParticipants = participants.filter(u => u.leadCompetition);

		if (activeParticipants.length === 0) {
			// Cascade: the last struggler standing leaves only if every other participant left via
			// this distance/lateral exit. Natural duration expiry does not cascade.
			if (participants.every(u => u.leadCompetitionDistanceExited)) {
				exitLeadCompetition(true);
			}
			return;
		}

		let behindAll = activeParticipants.every(u => u.pos - this.pos >= 5.0);
		// currentLane is only a simulated lane position when lane movement is enabled; with it off
		// (e.g. the Skill Chart, see umalator/app.tsx's buildChartOptions) it stays frozen at the
		// starting-gate lane, so a lateral comparison there would be a gate-draw artifact, not a
		// simulated fact.
		let lateralAll = this.laneMovementEnabled && activeParticipants.every(u => Math.abs(u.currentLane - this.currentLane) >= 0.416 * this.course.courseWidth);

		if (behindAll || lateralAll) {
			exitLeadCompetition(true);
		}
	}

	// Entry side (game's CompeteTop: CheckStartDistance 150, CheckEndSection 6, EndSection 9,
	// NigeCount/OonigeCount 1, DistanceGap1 3.75, LaneGap1 0.165). Like updatefirstUmaInLateRace()
	// below, this is a whole-field operation that any one uma's tick may perform: whichever uma of
	// the style runs first this frame triggers the entire group through this.umas, and everyone
	// else's own call that frame short-circuits on the leadCompetitionStart guard in
	// updateLeadCompetition().
	tryStartLeadCompetition() {
		if (!StrategyHelpers.strategyMatches(this.posKeepStrategy, Strategy.Nige)) {
			return;
		}

		// CheckStartDistance is field-global: ANY uma passing 150m unlocks spot struggle for the
		// whole field, so a trailing front runner can be pulled in before her own 150m mark
		// (hakuraku.moe/notes/spot-struggle: front runners triggering at ~137m behind an oonige
		// who was already past 150m). pos is monotonic, so this needs no latching flag.
		if (!this.umas.some(u => u.pos >= 150)) {
			return;
		}

		// Nige and Oonige are separate styles here (exact equality, not strategyMatches): they form
		// separate groups and get separate once-per-race budgets, per NigeCount/OonigeCount.
		// Umas with the mechanic disabled are excluded so they neither anchor a group nor get
		// spot-struggle state written onto them by someone else's tick (their own per-tick
		// processing never runs to unwind it, since updateLeadCompetition() returns immediately
		// when leadCompetitionEnabled is false).
		// ANCHOR: same-strategy-umas-filter
		let sameStrategyUmas = this.umas.filter(u => u.posKeepStrategy === this.posKeepStrategy && u.leadCompetitionEnabled);

		// NigeCount/OonigeCount: 1 -- one spot struggle per style per race, for the whole field.
		// There is no race-level object to hold that flag on, so it is derived from the field: any
		// same-style uma with a non-null leadCompetitionStart means this style already had its
		// struggle (leadCompetitionStart is set once at trigger and never cleared).
		if (sameStrategyUmas.some(u => u.leadCompetitionStart !== null)) {
			return;
		}

		if (sameStrategyUmas.length < 2) {
			return;
		}

		let frontmostUma = RaceSolver.frontmostByPos(sameStrategyUmas);
		let entryLaneGap = 0.165 * this.course.courseWidth;

		// DistanceGap1/LaneGap1, measured from the frontmost uma of the style -- who is trivially
		// within 0 of herself and so is always part of her own group.
		let umasWithinGap = sameStrategyUmas.filter(u => {
			let distanceBehind = frontmostUma.pos - u.pos;
			return distanceBehind >= 0 && distanceBehind < 3.75
				&& (!this.laneMovementEnabled || Math.abs(u.currentLane - frontmostUma.currentLane) < entryLaneGap);
		});

		if (umasWithinGap.length < 2) {
			return;
		}

		// CheckEndSection: 6 -- only ONE of the grouped umas needs to still be inside section 6.
		if (!umasWithinGap.some(u => u.pos <= Math.floor(this.sectionLength * 6))) {
			return;
		}

		// EndSection: 9 -- an absolute position shared by the whole group, not an offset from each
		// uma's own trigger point.
		let leadCompetitionEnd = Math.floor(this.sectionLength * 8);

		for (let uma of umasWithinGap) {
			uma.leadCompetitionTimer.t = 0;
			uma.leadCompetition = true;
			uma.leadCompetitionStart = uma.pos;
			uma.leadCompetitionEnd = leadCompetitionEnd;
		}
	}

	updatefirstUmaInLateRace() {
		let existingFirstPlaceUma = this.umas.find(u => u.firstUmaInLateRace);

		if (existingFirstPlaceUma) {
			return;
		}

		let sortedUmas = this.getUmaByDistanceDescending();
		let firstPlaceUma = sortedUmas[0];

		if (firstPlaceUma.pos < this.course.distance * 2/3) {
			return;
		}

		const firstPlacePos = Math.round(firstPlaceUma.pos * 100) / 100;
		const tiedUmas: RaceSolver[] = [];
		
		for (let uma of sortedUmas) {
			const umaPos = Math.round(uma.pos * 100) / 100;
			if (umaPos === firstPlacePos) {
				tiedUmas.push(uma);
			} else {
				break;
			}
		}

		// This is sooooooo hacky xDD
		// But when we have synced RNG both umas can reach late-race on the same frame
		// In which case, to avoid skewed final leg 1st place results...
		// ........ we do this
		const selectedUma = tiedUmas[this.syncRng.uniform(tiedUmas.length)];
		selectedUma.firstUmaInLateRace = true;
	}

	updateLastSpurtState(force: boolean = false) {
		if (this.isLastSpurt || this.phase < 2) return;
		if (this.lastSpurtTransition == -1 || force) {
			const initialLastSpurtSpeed = this.lastSpurtSpeed;
			const v = this.hp.getLastSpurtPair(this, this.lastSpurtSpeed, this.baseTargetSpeed[2]);
			this.lastSpurtTransition = v[0];
			this.lastSpurtSpeed = v[1];
			if ((this.hp as any).isMaxSpurt && (this.hp as any).isMaxSpurt()) {
				this.fullSpurt = true;
			} else {
				this.nonFullSpurtVelocityDiff = this.lastSpurtSpeed - initialLastSpurtSpeed;
				this.nonFullSpurtDelayDistance = this.lastSpurtTransition >= 0 ? this.lastSpurtTransition - (this.course.distance * 2 / 3) : null;
			}
		}
		if (this.pos >= this.lastSpurtTransition) {
			this.isLastSpurt = true;
		}
	}

	updateTargetSpeed() {
		if (!this.hp.hasRemainingHp()) {
			this.targetSpeed = this.minSpeed;
		} else if (this.isLastSpurt) {
			this.targetSpeed = this.lastSpurtSpeed;
		} else {
			this.targetSpeed = this.baseTargetSpeed[this.phase] * this.posKeepSpeedCoef;
			// Invariant that keeps this index in-bounds (sectionModifier has 25 entries,
			// 0..24, the last one an explicit "runs off the end of the track" slot -- see
			// its construction above): isLastSpurt latches true (below, in
			// updateLastSpurtState(), called before updateTargetSpeed() in step()) the
			// moment pos >= lastSpurtTransition, and every HpPolicy getLastSpurtPair()
			// return path bounds lastSpurtTransition <= course.distance -- so by the first
			// step where pos >= course.distance, isLastSpurt is already true and this
			// branch is never reached again. Don't reorder step()'s two calls without
			// re-checking this.
			this.targetSpeed += this.sectionModifier[Math.floor(this.pos / this.sectionLength)];
		}
		this.targetSpeed += this.modifiers.targetSpeed.acc + this.modifiers.targetSpeed.err;

		if (this.isDownhillMode) {
			// ANCHOR: downhill-accel-bonus-formula
			this.targetSpeed += 0.3 + this.slopePer / 100000.0;
		} else if (this.hillIdx != -1 && this.slopePer > 0) {
			// recalculating this every frame is actually measurably faster than calculating the penalty for each slope ahead of time, somehow
			// ANCHOR: uphill-slope-penalty-formula
			this.targetSpeed -= this.slopePer / 10000.0 * 200.0 / this.horse.power;
			this.targetSpeed = Math.max(this.targetSpeed, this.minSpeed);
		}

		if (this.competeFight) {
			// ANCHOR: duel-target-speed-bonus
			this.targetSpeed += Math.pow(200 * this.horse.guts, 0.708) * 0.0001;
		}

		if (this.leadCompetition) {
			// ANCHOR: spot-struggle-target-speed
			this.targetSpeed += Math.pow(500 * this.horse.guts, 0.6) * 0.0001;
		}

		if (this.laneChangeSpeed > 0.0 && this.activeLaneMovementSkills.length > 0) {
			// ANCHOR: lane-change-speed-modifier
			const moveLaneModifier = Math.sqrt(0.0002 * this.horse.power);
			this.targetSpeed += moveLaneModifier;
		}
	}

	applyForces() {
		if (!this.hp.hasRemainingHp()) {
			this.accel = -1.2;
			return;
		}
		if (this.currentSpeed > this.targetSpeed) {
			this.accel = this.positionKeepState === PositionKeepState.PaceDown ? -0.5 : PhaseDeceleration[this.phase];
			return;
		}
		this.accel = this.baseAccel[+(this.slopePer > 0) * 3 + this.phase];
		this.accel += this.modifiers.accel.acc + this.modifiers.accel.err;

		if (this.competeFight) {
			// ANCHOR: duel-accel-bonus
			this.accel += Math.pow(160 * this.horse.guts, 0.59) * 0.0001;
		}
	}

	// ANCHOR: downhill-mode-activation-gate
	downhillCheck(roll: number) {
		if (this.slopePer < 0 && roll < this.horse.wisdom * 0.0004) {
			this.downhillActivations.push([this.pos, this.pos]);
			this.isDownhillMode = true;
		}
	}

	updateHills() {
		if (this.hillIdx == -1 && this.hillStart.length > 0 && this.pos >= this.hillStart[this.hillStart.length - 1]) {
			this.hillIdx = this.nHills - this.hillStart.length;
			// ANCHOR: slope-per-update
			this.slopePer = this.course.slopes[this.hillIdx].slope;
			this.downhillTimer.t = 0;
			this.downhillCheck(this.downhillRng[this.hillIdx].random());
			this.hillStart.pop();
		} else if (this.hillIdx != -1 && this.hillEnd.length > 0 && this.pos > this.hillEnd[this.hillEnd.length - 1]) {
			this.hillIdx = -1;
			this.slopePer = 0;
			this.hillEnd.pop();
			if (this.isDownhillMode) this.downhillActivations[this.downhillActivations.length - 1][1] = this.pos;
			this.isDownhillMode = false;
		}

		if (this.downhillTimer.t >= 1.0 && this.hillIdx != -1) {
			const roll = this.downhillRng[this.hillIdx].random();

			if (this.isDownhillMode && roll > 0.8) {
				if (this.isDownhillMode) this.downhillActivations[this.downhillActivations.length - 1][1] = this.pos;
				this.isDownhillMode = false;
			} else if (!this.isDownhillMode) {
				this.downhillCheck(roll);
			}

			this.downhillTimer.t = 0.0;
		}
	}

	updatePhase() {
		// NB. there is actually a phase 3 which starts at 5/6 distance, but for purposes of
		// strategy phase modifiers, activate_count_end_after, etc it is the same as phase 2
		// and it's easier to treat them together, so cap phase at 2.
		if (this.pos >= this.nextPhaseTransition && this.phase < 2) {
			++this.phase;
			this.nextPhaseTransition = CourseHelpers.phaseStart(this.course.distance, this.phase + 1 as Phase);
		}
	}

	processSkillActivations() {
		for (let i = this.activeTargetSpeedSkills.length; --i >= 0;) {
			const s = this.activeTargetSpeedSkills[i];
			if (s.durationTimer.t >= 0) {
				this.activeTargetSpeedSkills.splice(i,1);
				this.modifiers.targetSpeed.add(-s.modifier);
				this.onSkillDeactivate(this, s.skillId, s.perspective);
			}
		}
		for (let i = this.activeCurrentSpeedSkills.length; --i >= 0;) {
			const s = this.activeCurrentSpeedSkills[i];
			if (s.durationTimer.t >= 0) {
				this.activeCurrentSpeedSkills.splice(i,1);
				this.modifiers.currentSpeed.add(-s.modifier);
				if (s.naturalDeceleration) {
					this.modifiers.oneFrameAccel += s.modifier;
				}
				this.onSkillDeactivate(this, s.skillId, s.perspective);
			}
		}
		for (let i = this.activeAccelSkills.length; --i >= 0;) {
			const s = this.activeAccelSkills[i];
			if (s.durationTimer.t >= 0) {
				this.activeAccelSkills.splice(i,1);
				this.modifiers.accel.add(-s.modifier);
				this.onSkillDeactivate(this, s.skillId, s.perspective);
			}
		}
		for (let i = this.activeLaneMovementSkills.length; --i >= 0;) {
			const s = this.activeLaneMovementSkills[i];
			if (s.durationTimer.t >= 0) {
				this.activeLaneMovementSkills.splice(i,1);
				this.onSkillDeactivate(this, s.skillId, s.perspective);
			}
		}
		for (let i = this.activeChangeLaneSkills.length; --i >= 0;) {
			const s = this.activeChangeLaneSkills[i];
			if (s.durationTimer.t >= 0) {
				this.activeChangeLaneSkills.splice(i,1);
				this.onSkillDeactivate(this, s.skillId, s.perspective);
			}
		}
		for (let i = this.pendingSkills.length; --i >= 0;) {
			const s = this.pendingSkills[i];
			if (this.pos >= s.trigger.end || this.pendingRemoval.has(s.skillId)) {  // NB. `Region`s are half-open [start,end) intervals. If pos == end we are out of the trigger.
				// skill failed to activate
				this.pendingSkills.splice(i,1);
				this.pendingRemoval.delete(s.skillId);
			} else if (this.pos >= s.trigger.start && s.extraCondition(this)) {
				// Check wisdom for skill activation if enabled
				if (!this.shouldSkipWisdomCheck(s) && !this.checkWisdomForSkill(s)) {
					// Skill fails due to low wisdom
					this.pendingSkills.splice(i,1);
				} else {
					this.activateSkill(s);
					this.pendingSkills.splice(i,1);
				}
			}
		}
		// activateSkill() (called above, possibly re-entrantly via doActivateRandomGold) bumped
		// activateCountThisFrame; is_activate_any_skill reads *last* frame's count, one frame delayed,
		// same as every other phase-check-before-phase-update timing quirk in this engine.
		this.activateCountLastFrame = this.activateCountThisFrame;
		this.activateCountThisFrame = 0;
	}

	checkWisdomForSkill(skill: PendingSkill): boolean {
		const wisdomKey = `${skill.skillId}:${skill.perspective ?? Perspective.Self}:${skill.trigger.start}:${skill.trigger.end}`;
		const rngRoll = new Rule30CARng(deriveSeed(this.skillWisdomSeed, wisdomKey)).random();
		const wisdom = skill.perspective === Perspective.Other && skill.originWisdom !== undefined 
			? skill.originWisdom 
			: this.horse.rawWisdom;
		let wisdomCheck = Math.max(100-9000/wisdom,20) * 0.01;
		return rngRoll <= wisdomCheck;
	}

	shouldSkipWisdomCheck(skill: PendingSkill): boolean {
		if (!this.skillWisdomCheck) {
			return true;
		}

		// Green skills
		if (skill.effects.length > 0 && skill.effects[0].type >= 1 && skill.effects[0].type <= 5) {
			return true;
		}

		// Uniques
		// (Inherited uniques are White rarity so this works fine)
		if (skill.rarity === SkillRarity.Unique) {
			return true;
		}

		return false;
	}


	// Applies the "Multiply Random" value-scaling roll (ability_value_usage 8 or 9 -- the game's
	// own docs treat them as identical) to a single effect's modifier, returning a shallow copy so
	// no `case` branch in activateSkill()'s switch needs to know this happened. Every other
	// valueUsage (in particular 1, "Direct") passes the effect through completely untouched.
	//
	// 60% -> 0.0x, 30% -> 0.02x, 10% -> 0.04x (game-mechanics/skills.md:182-188). The roll is
	// keyed by (skillValueSeed, skillId, perspective, effectIdx, activationCount) and drawn from a
	// fresh Rule30CARng via deriveSeed(), the same per-skill-key pattern as checkWisdomForSkill() --
	// deliberately NOT a shared sequential stream, which would desync every other skill's draw the
	// moment one horse in an A/B comparison carries an extra skill (see `this.umas` and
	// checkWisdomForSkill() above).
	scaleEffectValue(s: PendingSkill, ef0: SkillEffect, effectIdx: number): SkillEffect {
		if (ef0.valueUsage !== 8 && ef0.valueUsage !== 9) {
			return ef0;
		}
		const perspective = s.perspective ?? Perspective.Self;
		const activationCount = this.skillActivationCounts.get(`${s.skillId}:${perspective}`) ?? 0;
		const key = `${s.skillId}:${perspective}:${effectIdx}:${activationCount}`;
		const roll = new Rule30CARng(deriveSeed(this.skillValueSeed, key)).random();
		const scale = roll < 0.6 ? 0.0 : roll < 0.9 ? 0.02 : 0.04;
		return {...ef0, modifier: ef0.modifier * scale};
	}

	activateSkill(s: PendingSkill) {
		// sort so that the ExtendEvolvedDuration effect always activates after other effects, since it shouldn't extend the duration of other
		// effects on the same skill
		s.effects.sort((a,b) => +(a.type == 42) - +(b.type == 42)).forEach((ef0, effectIdx) => {
			const ef = this.scaleEffectValue(s, ef0, effectIdx);
			const scaledDuration = ef.baseDuration * (this.course.distance / 1000) *
				(s.rarity == SkillRarity.Evolution ? this.modifiers.specialSkillDurationScaling : 1);  // TODO should probably be awakened skills
				                                                                                       // and not just pinks
			switch (ef.type) {
			case SkillType.Noop:
				break;
			case SkillType.SpeedUp:
				this.horse.speed = Math.max(this.horse.speed + ef.modifier, 1);
				break;
			case SkillType.StaminaUp:
				this.horse.stamina = Math.max(this.horse.stamina + ef.modifier, 1);
				this.horse.rawStamina = Math.max(this.horse.rawStamina + ef.modifier, 1);
				break;
			case SkillType.PowerUp:
				this.horse.power = Math.max(this.horse.power + ef.modifier, 1);
				break;
			case SkillType.GutsUp:
				this.horse.guts = Math.max(this.horse.guts + ef.modifier, 1);
				break;
			case SkillType.WisdomUp:
				this.horse.wisdom = Math.max(this.horse.wisdom + ef.modifier, 1);
				break;
			case SkillType.MultiplyStartDelay:
				this.startDelay *= ef.modifier;
				break;
			case SkillType.SetStartDelay:
				this.startDelay = ef.modifier;
				break;
			case SkillType.TargetSpeed:
				this.modifiers.targetSpeed.add(ef.modifier);
				this.activeTargetSpeedSkills.push({skillId: s.skillId, perspective: s.perspective, durationTimer: this.getNewTimer(-scaledDuration), modifier: ef.modifier});
				break;
			case SkillType.Accel:
				this.modifiers.accel.add(ef.modifier);
				this.activeAccelSkills.push({skillId: s.skillId, perspective: s.perspective, durationTimer: this.getNewTimer(-scaledDuration), modifier: ef.modifier});
				break;
			case SkillType.LaneMovementSpeed:
				this.activeLaneMovementSkills.push({skillId: s.skillId, perspective: s.perspective, durationTimer: this.getNewTimer(-scaledDuration), modifier: ef.modifier});
				break;
			case SkillType.CurrentSpeed:
			case SkillType.CurrentSpeedWithNaturalDeceleration:
				this.modifiers.currentSpeed.add(ef.modifier);
				this.activeCurrentSpeedSkills.push({
					skillId: s.skillId, perspective: s.perspective, durationTimer: this.getNewTimer(-scaledDuration), modifier: ef.modifier,
					naturalDeceleration: ef.type == SkillType.CurrentSpeedWithNaturalDeceleration
				});
				break;
			case SkillType.Recovery:
				// ANCHOR: activate-count-heal-increment
				if (s.perspective == Perspective.Self) ++this.activateCountHeal;
				this.hp.recover(ef.modifier);
				if (this.phase >= 2 && !this.isLastSpurt) {
					this.updateLastSpurtState(true);
				}
				break;
			case SkillType.ActivateRandomGold:
				this.doActivateRandomGold(ef.modifier);
				break;
			case SkillType.ExtendEvolvedDuration:
				this.modifiers.specialSkillDurationScaling = ef.modifier;
				break;
			case SkillType.ChangeLane:
				this.activeChangeLaneSkills.push({skillId: s.skillId, perspective: s.perspective, durationTimer: this.getNewTimer(-scaledDuration), modifier: ef.modifier});
				break;
			}
		});
		// Bump after the fact so every effect within this one activation (all its effectIdx
		// values, read above by scaleEffectValue()) sees the same activationCount, and only the
		// *next* activation of this skillId+perspective pair draws independently from this one.
		{
			const activationKey = `${s.skillId}:${s.perspective ?? Perspective.Self}`;
			this.skillActivationCounts.set(activationKey, (this.skillActivationCounts.get(activationKey) ?? 0) + 1);
		}
		if (s.perspective == Perspective.Self) ++this.activateCount[this.phase];
		// counted here (not just in the pendingSkills loop in processSkillActivations) so that
		// doActivateRandomGold's re-entrant activateSkill() calls are counted too — "you have just
		// used another skill" should include Adventure of 564's forced activations.
		if (s.perspective == Perspective.Self && s.skillId != 'asitame' && s.skillId != 'staminasyoubu') {
			++this.activateCountThisFrame;
			if (this.pos >= this.course.distance / 2) ++this.activateCountLaterHalf;
		}
		this.usedSkills.add(s.skillId);
		this.onSkillActivate(this, s.skillId, s.perspective);
	}

	doActivateRandomGold(ngolds: number) {
		const goldIndices = this.pendingSkills.reduce((acc, skill, i) => {
			if ((skill.rarity == SkillRarity.Gold || skill.rarity == SkillRarity.Evolution) && skill.effects.every(ef => ef.type > SkillType.WisdomUp)) acc.push(i);
			return acc;
		}, []);
		for (let i = goldIndices.length; --i >= 0;) {
			const j = this.gorosiRng.uniform(i + 1);
			[goldIndices[i], goldIndices[j]] = [goldIndices[j], goldIndices[i]];
		}
		for (let i = 0; i < Math.min(ngolds, goldIndices.length); ++i) {
			const s = this.pendingSkills[goldIndices[i]];
			this.activateSkill(s);
			// important: we can't actually remove this from pendingSkills directly, since this function runs inside the loop in
			// processSkillActivations. modifying the pendingSkills array here would mess up that loop. this function used to modify
			// the trigger on the skill itself to ensure it was before this.pos and force it to be cleaned up, but mutating the skill
			// is error-prone and undesirable since it means the same PendingSkill instance can't be used with multiple RaceSolvers.
			// instead, flag the skill later to be removed in processSkillActivations (either later in the loop that called us, or
			// the next time processSkillActivations is called).
			this.pendingRemoval.add(s.skillId);
		}
	}

	// deactivate any skills that haven't finished their durations yet (intended to be called at the end of a simulation, when a skill
	// might have activated towards the end of the race and the race finished before the skill's duration)
	cleanup() {
		const callDeactivateHook = (s: {skillId: string, perspective?: Perspective}) => { this.onSkillDeactivate(this, s.skillId, s.perspective); }
		this.activeTargetSpeedSkills.forEach(callDeactivateHook);
		this.activeCurrentSpeedSkills.forEach(callDeactivateHook);
		this.activeAccelSkills.forEach(callDeactivateHook);
		this.activeLaneMovementSkills.forEach(callDeactivateHook);
		this.activeChangeLaneSkills.forEach(callDeactivateHook);
	}

	registerCondition(name: string, condition: ApproximateCondition): void {
		this.conditions.set(name, condition);

		if (!this.conditionValues.has(name)) {
			this.conditionValues.set(name, condition.valueOnStart);
		}
	}

	getConditionValue(name: string): number {
		if (!this.conditionValues.has(name)) {
			if (this.conditions.has(name)) {
				const condition = this.conditions.get(name)!;
				return condition.valueOnStart;
			}

			throw new Error(`Condition "${name}" is not registered`);
		}

		return this.conditionValues.get(name)!;
	}


	tickConditions(): void {
		const state = {
			simulation: this
		};

		for (const [name, condition] of this.conditions.entries()) {
			const currentValue = this.conditionValues.get(name) ?? condition.valueOnStart;
			const newValue = condition.update(state, currentValue);
			this.conditionValues.set(name, newValue);
		}
	}
}
