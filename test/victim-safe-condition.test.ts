import { describe, test, expect } from 'vitest';
import { victimSafeCondition, VictimSafeConditions } from '../RaceSolverBuilder';
import skills from '../data/jp/skill_data.json';

// Every term a debuff condition can use must be explicitly classified. This is the tripwire for a
// data refresh introducing a new term: an unclassified one fails here rather than silently
// evaluating against the victim (denylist failure) or widening the window (allowlist failure).
const CASTER_TERMS = new Set([
	'order', 'order_rate', 'running_style', 'change_order_onetime',
	'running_style_count_nige_otherself', 'running_style_count_senko_otherself',
	'running_style_count_sashi_otherself', 'running_style_count_oikomi_otherself',
	'blocked_front_continuetime',
	'temptation_opponent_count_behind', 'temptation_opponent_count_infront',
]);
const OTHER_TARGETS = new Set([2, 4, 9, 11, 18, 19, 20, 21, 22, 23]);

function debuffConditions(): string[] {
	const out: string[] = [];
	for (const s of Object.values(skills as any)) {
		for (const a of (s as any).alternatives) {
			for (const e of a.effects) {
				if (e.type === 9 && e.modifier < 0 && OTHER_TARGETS.has(e.target)) out.push(a.condition);
			}
		}
	}
	return out;
}

describe('victimSafeCondition', () => {
	test('strips caster terms, keeps timing and course terms', () => {
		expect(victimSafeCondition('distance_type==3&phase==1&blocked_front_continuetime>=1'))
			.toBe('distance_type==3&phase==1');                       // Murmur
		expect(victimSafeCondition('running_style==3&phase_random==2&order_rate>50'))
			.toBe('phase_random==2');                                 // All-Seeing Eyes
		expect(victimSafeCondition('phase==1&order_rate<=50&temptation_opponent_count_behind>=1'))
			.toBe('phase==1');                                        // Trick (Front), unregistered term
		expect(victimSafeCondition('running_style_count_nige_otherself>=1&phase_random==0&accumulatetime>=5'))
			.toBe('phase_random==0&accumulatetime>=5');                // Subdued Front Runners
	});

	test('filters each @-branch independently (& binds tighter than @)', () => {
		expect(victimSafeCondition('phase==1&order>=2@phase_random==2&running_style==3'))
			.toBe('phase==1@phase_random==2');
	});

	test('an emptied branch makes the whole condition unconditional', () => {
		expect(victimSafeCondition('order>=2')).toBe('');
		expect(victimSafeCondition('order>=2@phase==1')).toBe('');
	});

	test('every term in every shipped debuff condition is explicitly classified', () => {
		const unclassified = new Set<string>();
		for (const c of debuffConditions()) {
			for (const clause of c.split(/[&@]/)) {
				const term = clause.replace(/[<>=!].*/, '');
				if (!VictimSafeConditions.has(term) && !CASTER_TERMS.has(term)) unclassified.add(term);
			}
		}
		expect([...unclassified]).toEqual([]);
	});

	test('no shipped debuff condition strips to empty', () => {
		for (const c of debuffConditions()) expect(victimSafeCondition(c)).not.toBe('');
	});
});
