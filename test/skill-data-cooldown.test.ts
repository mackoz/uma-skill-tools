// SKL-21: make_skill_data.pl extracts master.mdb's float_cooldown_time_1/_2 onto each
// alternative as `cooldown` (seconds). The DB uses 5000000 as a "never re-trigger" sentinel and
// 0 for passives; both are written as an absent field, so the field's presence alone means
// "this alternative can re-trigger". Asserted as invariants rather than a fixed id list, since
// the data is regenerated whenever the game updates.
import { test } from 'vitest';
import { ok, strictEqual } from 'node:assert/strict';
import jp from '../data/jp/skill_data.json';
import global from '../data/global/skill_data.json';

function cooldowns(data: any): number[] {
	const out: number[] = [];
	for (const id of Object.keys(data)) {
		for (const alt of data[id].alternatives) {
			if ('cooldown' in alt) out.push(alt.cooldown);
		}
	}
	return out;
}

// The on-disk Global master.mdb predates the committed data/global/skill_data.json (which was
// last regenerated 2026-09-09 by SKL-7 from an mdb no longer on disk): regenerating Global from
// today's mdb would delete 45 released skills the committed JSON still has. So the existence
// check below only runs for JP; the Global half is a todo until a current master.mdb shows up
// (see SKL-21). The two invariant tests still run over both datasets -- they hold vacuously for
// Global today, which is fine for an invariant.
test('jp: some alternatives carry a cooldown', () => {
	ok(cooldowns(jp).length > 0, 'at least one alternative has a cooldown field');
});

test.todo('global: some alternatives carry a cooldown -- blocked on a current master.mdb, see SKL-21');

for (const [label, data] of [['jp', jp], ['global', global]] as [string, any][]) {
	test(`${label}: every cooldown is a positive finite number of seconds`, () => {
		for (const cd of cooldowns(data)) {
			ok(Number.isFinite(cd) && cd > 0, `cooldown ${cd} is positive and finite`);
			ok(cd < 500, `cooldown ${cd}s is a real cooldown, not the 5000000 raw sentinel`);
		}
	});

	test(`${label}: the sentinel and passive rows are omitted, not written as 0 or 500`, () => {
		const values = new Set(cooldowns(data));
		ok(!values.has(0), 'no zero-valued cooldown fields');
		ok(!values.has(500), 'the 5000000 sentinel was not scaled and written through');
	});
}
