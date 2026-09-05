// DYN-14: Spot Struggle's trigger/exit geometry was a simplified stand-in -- symmetric distance
// around whichever uma's tick happened to run, no lateral check, 5m entry for Oonige, no
// distance-based exit, a relative (not absolute) EndSection cap, and a self-only (not
// field-global) 150m unlock. This pins the fixed geometry against the game's own CompeteTop
// parameter block, confirmed by hakuraku.moe/notes/spot-struggle's replay-frame analysis:
//   CheckStartDistance 150, CheckEndSection 6, EndSection 9, NigeCount/OonigeCount 1,
//   DistanceGap1 3.75, LaneGap1 0.165, DistanceGap2 5.0, LaneGap2 0.416.
import { test } from 'vitest';
import { ok, strictEqual, notStrictEqual } from 'node:assert/strict';
import { RaceSolver, Timer } from '../RaceSolver';
import { Aptitude, Strategy } from '../HorseTypes';
import { attachMethods, field } from './RaceSolverTestHelpers';

const COURSE_WIDTH = 11.25;
const SECTION_LENGTH = 100; // matches hakuraku's worked example (2400m / 24 sections -> section 6 ends at 600m)

// tryStartLeadCompetition()/updateLeadCompetitionExit() only touch a handful of instance fields
// (see RaceSolver.ts); build a minimal stand-in rather than a full RaceSolver, same spirit as
// test/rushed-escape-roll.test.ts and test/spot-struggle-duration.test.ts.
function makeUma(pos: number, strategy: Strategy, opts: {lane?: number, laneMovement?: boolean} = {}) {
	return attachMethods({
		leadCompetitionEnabled: true,
		leadCompetition: false,
		leadCompetitionStart: null as number | null,
		leadCompetitionEnd: null as number | null,
		leadCompetitionDistanceExited: false,
		leadCompetitionTimer: new Timer(0),
		laneMovementEnabled: opts.laneMovement !== false,
		pos,
		currentLane: opts.lane ?? 0,
		posKeepStrategy: strategy,
		sectionLength: SECTION_LENGTH,
		course: {courseWidth: COURSE_WIDTH},
		horse: {guts: 1200, strategyAptitude: Aptitude.A}, // ~11s duration, never the limiting factor here
		umas: [] as any[],
	}, 'tryStartLeadCompetition', 'updateLeadCompetitionExit');
}

const tryStart = (u: any) => RaceSolver.prototype.tryStartLeadCompetition.call(u);
const exit = (u: any) => RaceSolver.prototype.updateLeadCompetitionExit.call(u);

// ===================== entry geometry =====================

test('entry is measured from the frontmost uma, not symmetrically around the caller', () => {
	const a = makeUma(302, Strategy.Nige); // frontmost
	const b = makeUma(299, Strategy.Nige); // 3m behind a -- within gap
	const c = makeUma(297.5, Strategy.Nige); // 4.5m behind a (but only 1.5m from b) -- outside gap
	field(a, b, c);

	tryStart(b); // call on the non-frontmost uma; the old symmetric check would wrongly pull in c

	notStrictEqual(a.leadCompetitionStart, null, 'frontmost uma joins');
	notStrictEqual(b.leadCompetitionStart, null, 'caller, 3m behind frontmost, joins');
	strictEqual(c.leadCompetitionStart, null, '4.5m behind frontmost stays out, despite being close to the caller');
});

test('Oonige uses the 3.75m DistanceGap1, not a wider 5m entry', () => {
	const noTrigger = field(makeUma(200.0, Strategy.Oonige), makeUma(204.1, Strategy.Oonige)); // 4.1m apart
	tryStart(noTrigger[0]);
	ok(noTrigger.every(u => u.leadCompetitionStart === null), '4.1m apart never triggers (would have under the old 5m rule)');

	const triggers = field(makeUma(200.0, Strategy.Oonige), makeUma(203.1, Strategy.Oonige)); // 3.1m apart
	tryStart(triggers[0]);
	ok(triggers.every(u => u.leadCompetitionStart !== null), '3.1m apart triggers');
});

test('LaneGap1 blocks entry laterally', () => {
	const blocked = field(makeUma(200, Strategy.Nige, {lane: 0}), makeUma(201.5, Strategy.Nige, {lane: 2.0}));
	tryStart(blocked[0]);
	ok(blocked.every(u => u.leadCompetitionStart === null), '2.0m lane gap (> 0.165*11.25 = 1.856m) blocks entry');

	const allowed = field(makeUma(200, Strategy.Nige, {lane: 0}), makeUma(201.5, Strategy.Nige, {lane: 1.8}));
	tryStart(allowed[0]);
	ok(allowed.every(u => u.leadCompetitionStart !== null), '1.8m lane gap (< 1.856m) allows entry');
});

test('lateral entry check is skipped when lane movement is disabled', () => {
	const umas = field(
		makeUma(200, Strategy.Nige, {lane: 0, laneMovement: false}),
		makeUma(201.5, Strategy.Nige, {lane: 2.0, laneMovement: false}),
	);
	tryStart(umas[0]);
	ok(umas.every(u => u.leadCompetitionStart !== null), 'a 2.0m lane gap is ignored with lane movement off (e.g. the Skill Chart)');
});

test('the entry window is section 6 (sectionLength * 6), not section 5', () => {
	// hakuraku's own worked example: section 6 ends at 600m on a 100m-section course; Maruzensky
	// at 602.8m had already passed it, but Bourbon at 599.2m was still within it and triggered.
	const triggers = field(makeUma(602.8, Strategy.Nige), makeUma(599.2, Strategy.Nige));
	tryStart(triggers[0]);
	ok(triggers.every(u => u.leadCompetitionStart !== null), 'triggers because 599.2 <= sectionLength*6 (600)');

	const noTrigger = field(makeUma(604, Strategy.Nige), makeUma(601, Strategy.Nige));
	tryStart(noTrigger[0]);
	ok(noTrigger.every(u => u.leadCompetitionStart === null), 'neither uma is within section 6 (601 > 600) -- no trigger');
});

test('CheckStartDistance (150m) unlocks spot struggle field-globally, not per-uma', () => {
	const tooEarly = field(makeUma(137, Strategy.Nige), makeUma(135, Strategy.Nige));
	tryStart(tooEarly[0]);
	ok(tooEarly.every(u => u.leadCompetitionStart === null), 'neither uma has reached 150m -- no trigger');

	const unlockedByOther = field(makeUma(137, Strategy.Nige), makeUma(135, Strategy.Nige), makeUma(151, Strategy.Oonige));
	tryStart(unlockedByOther[0]);
	ok(unlockedByOther[0].leadCompetitionStart !== null && unlockedByOther[1].leadCompetitionStart !== null,
		'a third uma (any style) past 150m unlocks the field-wide check, so the 137/135 pair triggers early');
});

test('EndSection (9) is an absolute position shared by the group, not an offset from each trigger point', () => {
	const umas = field(makeUma(302, Strategy.Nige), makeUma(299, Strategy.Nige));
	tryStart(umas[0]);
	const expectedEnd = Math.floor(SECTION_LENGTH * 8); // 800, not 302+800 or 299+800
	strictEqual(umas[0].leadCompetitionEnd, expectedEnd, `frontmost uma's cap is the absolute ${expectedEnd}`);
	strictEqual(umas[1].leadCompetitionEnd, expectedEnd, `other member's cap is the same absolute ${expectedEnd}, not pos-relative`);
});

test('NigeCount/OonigeCount: 1 -- each style triggers once per race, independently of the other style', () => {
	// The frontmost-of-all-Nige is uma4 (251), so she and uma3 (250, 1m behind) form the one Nige
	// group; uma1/uma2 are too far back (50-51m) to be included and are left untriggered.
	const nige1 = makeUma(200, Strategy.Nige);
	const nige2 = makeUma(201, Strategy.Nige);
	const nige3 = makeUma(250, Strategy.Nige);
	const nige4 = makeUma(251, Strategy.Nige);
	const oonige1 = makeUma(300, Strategy.Oonige);
	const oonige2 = makeUma(301, Strategy.Oonige);
	field(nige1, nige2, nige3, nige4, oonige1, oonige2);

	tryStart(nige4);
	ok(nige3.leadCompetitionStart !== null && nige4.leadCompetitionStart !== null, 'the near pair (nige3/nige4) triggers');
	ok(nige1.leadCompetitionStart === null && nige2.leadCompetitionStart === null, 'the far pair is left out of that group');

	tryStart(nige1); // Nige already triggered this race -- must be a no-op regardless of nige1's own position
	ok(nige1.leadCompetitionStart === null, 'Nige style already used its one-per-race budget; no second group forms');

	tryStart(oonige1); // a completely separate style, unaffected by Nige's trigger
	ok(oonige1.leadCompetitionStart !== null && oonige2.leadCompetitionStart !== null, 'Oonige triggers independently of Nige');
});

// ===================== distance/lateral exit =====================

// `end` defaults to Infinity (i.e. never exits via the duration/position cap) so callers testing
// the distance/lateral exit branch don't each need their own `u.leadCompetitionEnd = Infinity;`
// line to isolate it from the cap exit -- pass an explicit `end` (e.g. the real section-9 cap)
// only when the cap itself is what's under test.
function makeActiveParticipant(pos: number, strategy: Strategy, lane = 0, end = Infinity) {
	const u = makeUma(pos, strategy, {lane});
	u.leadCompetitionStart = 0;
	u.leadCompetition = true;
	u.leadCompetitionEnd = end;
	return u;
}

// An uma who has already left a struggle before the test's exit() call under test runs -- mirrors
// makeActiveParticipant() for the "already departed" half of a participants list.
function makeExitedParticipant(pos: number, strategy: Strategy, distanceExited: boolean) {
	const u = makeUma(pos, strategy);
	u.leadCompetitionStart = 0;
	u.leadCompetition = false;
	u.leadCompetitionDistanceExited = distanceExited;
	return u;
}

test('distance exit (DistanceGap2) requires clearing every active participant, not just the nearest', () => {
	const x = makeActiveParticipant(400, Strategy.Nige);
	const y = makeActiveParticipant(396, Strategy.Nige);
	const z = makeActiveParticipant(394, Strategy.Nige); // evaluated uma: 6m behind x, but only 2m behind y
	field(x, y, z);

	exit(z);
	ok(z.leadCompetition, 'stays active: not yet >=5m behind every active participant (only x, not y)');

	z.pos = 390; // now 10m behind x and 6m behind y
	exit(z);
	ok(!z.leadCompetition, 'exits once >=5m behind ALL active participants');
	ok(z.leadCompetitionDistanceExited, 'flagged as a distance exit, for the cascade rule');
	strictEqual(z.leadCompetitionEnd, 390, 'leadCompetitionEnd records where she actually left');
});

test('lateral exit (LaneGap2)', () => {
	const blocked = makeActiveParticipant(400, Strategy.Nige, 5.0);
	const z1 = makeActiveParticipant(400, Strategy.Nige, 0);
	field(blocked, z1);
	exit(z1);
	ok(!z1.leadCompetition, '5.0m lane gap (>= 0.416*11.25 = 4.68m) triggers the lateral exit');
	ok(z1.leadCompetitionDistanceExited);

	const close = makeActiveParticipant(400, Strategy.Nige, 4.0);
	const z2 = makeActiveParticipant(400, Strategy.Nige, 0);
	field(close, z2);
	exit(z2);
	ok(z2.leadCompetition, '4.0m lane gap (< 4.68m) does not trigger it');
});

test('cascade: the last struggler exits once every other participant left via the distance/lateral exit', () => {
	const a = makeActiveParticipant(500, Strategy.Nige);
	const b = makeExitedParticipant(480, Strategy.Nige, true);
	const c = makeExitedParticipant(470, Strategy.Nige, true);
	field(a, b, c);

	exit(a);
	ok(!a.leadCompetition, 'the last active struggler exits once everyone else has distance-exited');
	ok(a.leadCompetitionDistanceExited);
});

test('cascade does not fire from natural duration/position-cap expiry', () => {
	const a = makeActiveParticipant(500, Strategy.Nige);
	const b = makeExitedParticipant(480, Strategy.Nige, false); // left naturally, not via the distance exit
	field(a, b);

	exit(a);
	ok(a.leadCompetition, 'stays active: the one other participant did not leave via a distance exit');
});

test('the section-9 cap exit is never misreported as a distance exit', () => {
	const a = makeActiveParticipant(800, Strategy.Nige, 0, Math.floor(SECTION_LENGTH * 8)); // she has just reached the cap
	const nearby = makeActiveParticipant(800, Strategy.Nige); // would also satisfy a (trivial) distance/lateral check
	field(a, nearby);

	exit(a);
	ok(!a.leadCompetition, 'exits via the position cap');
	ok(!a.leadCompetitionDistanceExited, 'NOT flagged as a distance exit -- the cap check returns before that logic runs');
	strictEqual(a.leadCompetitionEnd, 800);
});
