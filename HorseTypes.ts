import { strict as assert } from 'node:assert';

export const enum Strategy { Nige = 1, Senkou, Sasi, Oikomi, Oonige }
export const enum Aptitude { S, A, B, C, D, E, F, G }

// Aptitude-rank multiplier, indexed by Aptitude (S=0 .. G=7). Used for two distinct things:
// scaling wisdom in buildAdjustedStats() (RaceSolverBuilder.ts) and scaling spot-struggle
// duration in updateLeadCompetition() (RaceSolver.ts). Matches the game's own CompeteTop
// parameter block (S 1.1 / A 1.0 / B 0.85 / C 0.75 / D 0.6 / E 0.4 / F 0.2 / G 0.1).
export const StrategyProficiencyModifier = Object.freeze([1.1, 1.0, 0.85, 0.75, 0.6, 0.4, 0.2, 0.1]);

export interface HorseParameters {
	readonly speed: number
	readonly stamina: number
	readonly power: number
	readonly guts: number
	readonly wisdom: number
	readonly strategy: Strategy
	readonly distanceAptitude: Aptitude
	readonly surfaceAptitude: Aptitude
	readonly strategyAptitude: Aptitude
	readonly rawStamina: number
	readonly rawWisdom: number
}

export namespace StrategyHelpers {
	export function assertIsStrategy(strategy: number): asserts strategy is Strategy {
		assert(Strategy.hasOwnProperty(strategy));
	}

	export function strategyMatches(s1: Strategy, s2: Strategy) {
		return s1 == s2 || (s1 == Strategy.Nige && s2 == Strategy.Oonige) || (s1 == Strategy.Oonige && s2 == Strategy.Nige);
	}
}
