// Decoder for hakuraku-format saved-race JSON (Global-client `deserialize()` path only —
// see hakuraku/src/data/RaceDataParser.ts for the reference this was ported from, and
// PIPE-21 in uma-tools-plans for why this exists). Ported from a throwaway Python script
// verified against all 20 files in uma-tools-plans/replay-corpus/champions-meeting-10903/
// during that ticket's research phase — this is not a fresh re-derivation from the .proto
// schema, it's a straight port of an already-checked struct layout.
//
// The struct is a packed little-endian binary blob, gzip+base64-encoded into the JSON's
// `simDataBase64` field:
//   header:      ii     = int32 maxLength, int32 version                    (4 + maxLength bytes)
//   raceStruct:  fiii   = float32 distanceDiffMax, int32 horseNum, int32 horseFrameSize, int32 horseResultSize
//   [padding1]
//   frameHeader: ii     = int32 frameCount, int32 frameSize
//   frame*:      f + (fHHHbb)*horseNum   = float32 time, then per horse: distance, lanePosition(u16), speed(u16), hp(u16), temptationMode(i8), blockFrontHorseIndex(i8)
//   [padding2]
//   horseResult*: ifffBBfBif = int32 finishOrder, f finishTime, f finishDiffTime, f startDelayTime, u8 gutsOrder, u8 wizOrder, f lastSpurtStartDistance, u8 runningStyle, i32 defeat, f finishTimeRaw
//   [padding3]
//   eventCount:  i
//   event*:      i16 eventSize, then (fbb + int32*paramCount) = float32 frameTime, i8 type, i8 paramCount, params
//
// Known quirks (see PIPE-21's Evidence section for how these were confirmed):
// - speed is stored *100 and lanePosition is stored *10000 on this (global) path. The
//   parser's own `normalizeSpeed`/`normalizeLanePosition` helpers are JP-parser-only —
//   do NOT apply them here, just divide.
// - SKILL event param[0] is a 0-based horseIndex (not `frame_order`), param[1] is the
//   skillId, param[2] is duration in 1e-4s (already distance-scaled, -1 for t=0 passives).
// - horseResult.finishOrder here is 0-based -- and so, actually, is the JSON's own
//   top-level raceHorse[].finishOrder (verified across all 20 corpus files: observed
//   range 0..8 for a 9-horse field). An earlier version of this comment claimed the
//   top-level field was 1-based; that was wrong (PIPE-37). This file only ever reads the
//   binary horseResult.finishOrder, so nothing downstream was affected -- just the doc.
// - Frame cadence is NOT a uniform 1/15s: dense (0.0666s) for the first ~1.07s and last
//   ~2.8s of the race, sparse (1.0656s, every 16th tick) for the middle ~97%. Don't assume
//   evenly-spaced frames.

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

export interface HorseFrame {
	distance: number;
	lanePosition: number; // already divided by 10000
	speed: number;        // already divided by 100, m/s
	hp: number;
	temptationMode: number;
	blockFrontHorseIndex: number; // -1 = not blocked
}

export interface Frame {
	time: number;
	horseFrame: HorseFrame[];
}

export interface HorseResult {
	finishOrder: number; // 0-based -- same as the JSON's own top-level raceHorse[].finishOrder (see the file header)
	finishTime: number;
	finishDiffTime: number;
	startDelayTime: number;
	gutsOrder: number;
	wizOrder: number;
	lastSpurtStartDistance: number;
	runningStyle: number; // 0=NONE 1=NIGE(Front) 2=SENKO(Pace) 3=SASHI(Late) 4=OIKOMI(End)
	// The game's own post-race "reason you lost" analysis tag, NOT a boolean DQ/DNF flag --
	// every horse in every race has a truthy value here (1=Win is itself a truthy code).
	// Decoded across all 540 horse-results in the champions-meeting-10903 corpus: 1=Win,
	// 2=Lose, 4=Temptaion [sic, the game's own typo], 5=GutsOrder, 8=LastSpurtTargetSpeedDec,
	// 9=PassiveSkillNum, 10=BlockFrontTime, 11=Speed, 12=ProperDistance, 14=Motivation.
	// There is no DQ/DNF concept observed anywhere in that corpus (finishOrder is always a
	// clean 0..8 permutation, no sentinel finishTimeRaw, no horse ending short of course
	// distance) -- don't build a "skip defeated horses" filter off this field alone.
	defeat: number;
	finishTimeRaw: number;
}

export const enum SimulateEventType {
	SCORE = 0,
	CHALLENGE_MATCH_POINT = 1,
	NOUSE_2 = 2,
	SKILL = 3,
	COMPETE_TOP = 4,          // Spot Struggle
	COMPETE_FIGHT = 5,        // Dueling
	RELEASE_CONSERVE_POWER = 6,
	STAMINA_LIMIT_BREAK_BUFF = 7,
	COMPETE_BEFORE_SPURT = 8,
	STAMINA_KEEP = 9,
	SECURE_LEAD = 10,
}

export interface RaceEvent {
	frameTime: number;
	type: number;
	paramCount: number;
	param: number[];
}

export interface ParsedReplay {
	maxLength: number;
	version: number;
	distanceDiffMax: number;
	horseNum: number;
	horseFrameSize: number;
	horseResultSize: number;
	frameCount: number;
	frameSize: number;
	frame: Frame[];
	horseResult: HorseResult[];
	eventCount: number;
	event: RaceEvent[];
	bytesConsumed: number;
	totalBytes: number;
}

const RACE_STRUCT_SIZE = 16;
const EVENT_STRUCT_SIZE = 6;

function ensure(view: DataView, offset: number, size: number) {
	if (offset < 0 || size < 0 || offset + size > view.byteLength) {
		throw new Error(`Out-of-bounds race data at offset ${offset}, size ${size}, buffer length ${view.byteLength}`);
	}
}

export function deserialize(buf: Buffer): ParsedReplay {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

	ensure(view, 0, 8);
	const maxLength = view.getInt32(0, true);
	const version = view.getInt32(4, true);
	ensure(view, 0, 4 + maxLength);
	let off = 4 + maxLength;

	ensure(view, off, RACE_STRUCT_SIZE);
	const distanceDiffMax = view.getFloat32(off, true);
	const horseNum = view.getInt32(off + 4, true);
	const horseFrameSize = view.getInt32(off + 8, true);
	const horseResultSize = view.getInt32(off + 12, true);
	off += RACE_STRUCT_SIZE;

	if (!(horseNum > 0 && horseNum <= 30) || !(horseFrameSize > 0 && horseFrameSize <= 64) || !(horseResultSize > 0 && horseResultSize <= 256)) {
		throw new Error(`Implausible race struct: horseNum=${horseNum} horseFrameSize=${horseFrameSize} horseResultSize=${horseResultSize}`);
	}

	ensure(view, off, 4);
	const paddingSize1 = view.getInt32(off, true);
	off += 4 + paddingSize1;

	ensure(view, off, 8);
	const frameCount = view.getInt32(off, true);
	const frameSize = view.getInt32(off + 4, true);
	off += 8;

	if (frameCount < 0) throw new Error(`Negative frameCount ${frameCount}`);
	ensure(view, off, frameCount * frameSize);

	const frame: Frame[] = [];
	for (let i = 0; i < frameCount; i++) {
		const time = view.getFloat32(off, true);
		let o = off + 4;
		const horseFrame: HorseFrame[] = [];
		for (let h = 0; h < horseNum; h++) {
			horseFrame.push({
				distance: view.getFloat32(o, true),
				lanePosition: view.getUint16(o + 4, true) / 10000,
				speed: view.getUint16(o + 6, true) / 100,
				hp: view.getUint16(o + 8, true),
				temptationMode: view.getInt8(o + 10),
				blockFrontHorseIndex: view.getInt8(o + 11),
			});
			o += horseFrameSize;
		}
		frame.push({time, horseFrame});
		off += frameSize;
	}

	ensure(view, off, 4);
	const paddingSize2 = view.getInt32(off, true);
	off += 4 + paddingSize2;

	const horseResult: HorseResult[] = [];
	for (let i = 0; i < horseNum; i++) {
		ensure(view, off, horseResultSize);
		horseResult.push({
			finishOrder: view.getInt32(off, true),
			finishTime: view.getFloat32(off + 4, true),
			finishDiffTime: view.getFloat32(off + 8, true),
			startDelayTime: view.getFloat32(off + 12, true),
			gutsOrder: view.getUint8(off + 16),
			wizOrder: view.getUint8(off + 17),
			lastSpurtStartDistance: view.getFloat32(off + 18, true),
			runningStyle: view.getUint8(off + 22),
			defeat: view.getInt32(off + 23, true),
			finishTimeRaw: view.getFloat32(off + 27, true),
		});
		off += horseResultSize;
	}

	ensure(view, off, 4);
	const paddingSize3 = view.getInt32(off, true);
	off += 4 + paddingSize3;

	ensure(view, off, 4);
	const eventCount = view.getInt32(off, true);
	off += 4;

	const event: RaceEvent[] = [];
	for (let i = 0; i < eventCount; i++) {
		ensure(view, off, 2);
		const eventSize = view.getInt16(off, true);
		off += 2;
		ensure(view, off, EVENT_STRUCT_SIZE);
		const frameTime = view.getFloat32(off, true);
		const type = view.getInt8(off + 4);
		const paramCount = view.getInt8(off + 5);
		let o = off + EVENT_STRUCT_SIZE;
		const param: number[] = [];
		for (let p = 0; p < paramCount; p++) {
			param.push(view.getInt32(o, true));
			o += 4;
		}
		event.push({frameTime, type, paramCount, param});
		off += eventSize;
	}

	return {
		maxLength, version, distanceDiffMax, horseNum, horseFrameSize, horseResultSize,
		frameCount, frameSize, frame, horseResult, eventCount, event,
		bytesConsumed: off, totalBytes: buf.byteLength,
	};
}

// The blob is gzip, not bare zlib/deflate — Node's zlib needs the right entry point
// (gunzipSync), unlike pako.inflate which auto-detects the wrapper.
export function inflateSimData(base64: string): Buffer {
	return zlib.gunzipSync(Buffer.from(base64, 'base64'));
}

export function parseReplayFile(filePath: string): {json: any, raw: Buffer, parsed: ParsedReplay} {
	const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
	const raw = inflateSimData(json.simDataBase64);
	return {json, raw, parsed: deserialize(raw)};
}

export interface SkillActivation {
	time: number;
	skillId: number;
	durationSec: number | null;
	param3: number;
	param4: number;
}

// -> {horseIndex: [activation, ...]} in time order. horseIndex is 0-based, matching
// SKILL event param[0] — NOT the same indexing as `frame_order` elsewhere in hakuraku.
export function skillTimeline(parsed: ParsedReplay): Map<number, SkillActivation[]> {
	const out = new Map<number, SkillActivation[]>();
	for (const e of parsed.event) {
		if (e.type !== SimulateEventType.SKILL) continue;
		const horseIndex = e.param[0];
		const skillId = e.param[1];
		const durationRaw = e.param[2];
		const activation: SkillActivation = {
			time: e.frameTime,
			skillId,
			durationSec: durationRaw >= 0 ? durationRaw / 10000 : null,
			param3: e.param[3],
			param4: e.param[4],
		};
		if (!out.has(horseIndex)) out.set(horseIndex, []);
		out.get(horseIndex)!.push(activation);
	}
	for (const list of out.values()) list.sort((a, b) => a.time - b.time);
	return out;
}

const RUNNING_STYLE_NAME: Record<number, string> = {
	0: 'NONE', 1: 'NIGE(Front)', 2: 'SENKO(Pace)', 3: 'SASHI(Late)', 4: 'OIKOMI(End)',
};

function main() {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		console.error('usage: tsx parseReplay.ts <race.json>');
		console.error('       tsx parseReplay.ts --all <dir>');
		process.exit(1);
	}
	if (args[0] === '--all') {
		const dir = args[1];
		const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
		for (const f of files) {
			const full = path.join(dir, f);
			try {
				const {parsed} = parseReplayFile(full);
				console.log(`OK   ${f.padEnd(40)} hn=${parsed.horseNum} frames=${parsed.frameCount} events=${parsed.eventCount} consumed=${parsed.bytesConsumed}/${parsed.totalBytes}`);
			} catch (e) {
				console.log(`FAIL ${f.padEnd(40)} ${(e as Error).message}`);
			}
		}
		return;
	}

	const {json, raw, parsed} = parseReplayFile(args[0]);
	console.log(`inflated=${raw.length}B maxLength=${parsed.maxLength} version=${parsed.version} ` +
		`horseNum=${parsed.horseNum} horseFrameSize=${parsed.horseFrameSize} horseResultSize=${parsed.horseResultSize} ` +
		`frameCount=${parsed.frameCount} frameSize=${parsed.frameSize} eventCount=${parsed.eventCount}`);

	console.log('\nHORSE RESULTS');
	parsed.horseResult.forEach((r, i) => {
		const name = (json.raceHorse[i].charaName as string).slice(0, 16).padEnd(16);
		console.log(`  ${i} ${name} ord=${r.finishOrder} t=${r.finishTimeRaw.toFixed(4)} ` +
			`delay=${r.startDelayTime.toFixed(4)} spurt=${r.lastSpurtStartDistance.toFixed(2)} ` +
			`style=${RUNNING_STYLE_NAME[r.runningStyle]}`);
	});

	console.log('\nSKILL TIMELINE');
	const timeline = skillTimeline(parsed);
	for (const [horseIndex, activations] of [...timeline.entries()].sort((a, b) => a[0] - b[0])) {
		console.log(`  horse ${horseIndex} (${json.raceHorse[horseIndex].charaName})`);
		for (const a of activations) {
			console.log(`    t=${a.time.toFixed(4)} skill=${a.skillId} dur=${a.durationSec}s p3=${a.param3} p4=${a.param4}`);
		}
	}
}

if (require.main === module) {
	main();
}
