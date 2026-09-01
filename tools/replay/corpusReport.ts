// PIPE-37: corpus-wide JSON emitter for the sim-vs-replay accuracy report. No statistics
// live here -- this walks a corpus of hakuraku-format replays (private-repo-only, see
// ../../../../plans/replay-corpus/champions-meeting-10903/README.md for why), runs
// replayDiff.run() over each file, and emits one JSON document that
// tools/replay/analyze_replay_diff.py consumes. Reuses two existing patterns rather than
// reinventing them: the mixed-course guard from measureDownhill.ts, and the per-file
// try/catch isolation from parseReplay.ts's --all mode (neither existing file combines
// both).
//
// PRIVACY -- read this before touching the emitted schema. The corpus carries other
// players' trainer names, nicknames, and full builds (see the corpus README). This tool
// runs in the PUBLIC engine repo and its output feeds a shareable artifact, so redaction
// happens once, here, at construction time -- never as a later stripping pass over a
// richer object:
//   - A run is "own" iff its raceHorse[].trainerName matches the replay's own
//     playerHorseIndex entry. Own runs may carry real identity + full detail (they're the
//     maintainer's own data).
//   - Every other run is built field-by-field from the OTHER_RUN_KEYS allowlist below --
//     never by stripping fields off a richer object, which is exactly the mistake an
//     earlier draft of this ticket made (a denylist aimed at responseHorseData missed
//     raceHorse[].trainedCharaData, a second, undocumented copy of the same private data
//     present on every run).
//   - Non-own build identity is a sequential opaque index ("b0", "b1", ...) assigned in
//     first-encounter order, keyed privately on (trainerName, trained_chara_id) -- that
//     private key is never emitted. Not a hash: a hash of a short trainer name is
//     brute-forceable for membership inference straight from a published artifact.
//   - assertRedacted() below is the structural publish gate: it walks every string value
//     in the final output and throws if any equals a collected redacted string. This is
//     deliberately NOT a substring/grep check -- several trainer names in the reference
//     corpus are 1-2 characters, so a "grep -F, zero hits" check would be guaranteed to
//     "fail" against a multi-megabyte JSON blob and just get waived, which is worse than no
//     gate. See tools/README.md's corpusReport.ts section for the full verification story.

import * as fs from 'fs';
import * as path from 'path';

import { CourseHelpers } from '../../CourseData';
import { run, HorseDiffResult, DiffSample, rms, mean } from './replayDiff';
import { parseReplayFile, ParsedReplay } from './parseReplay';

interface OwnRunRecord {
	own: true;
	file: string;
	horseIndex: number;
	buildKey: string; // real charaName -- own builds are the maintainer's own data
	charaName: string;
	runningStyle: number;
	skillsInBuild: number;
	skillsActivated: number;
	skillsPinned: number;
	skillLevelMean: number;
	skillLevelMax: number;
	blockedFrameCount: number;
	temptationFrameCount: number;
	temptationModeMax: number;
	realFinishOrder: number;
	realFinishTime: number;
	simFinishTime: number | null;
	simDistAtRealFinish: number | null;
	finishPosErrBasinn: number | null; // (simDistAtRealFinish - course.distance) / 2.5
	realHp0: number;
	simMaxHp: number;
	realLastSpurtStartDistance: number;
	simLastSpurtTransition: number;
	simFullSpurt: boolean;
	simNonFullSpurtDelayDistance: number | null;
	distErrMeanM: number | null;
	distErrRmsM: number | null;
	speedErrMeanMs: number | null;
	speedErrRmsMs: number | null;
	hpErrMean: number | null;
	hpErrRmsM: number | null;
	samples: DiffSample[];
}

// Everything an own run carries minus real identity (charaName -> opaque buildKey, which
// is already what a non-own run's buildKey is) and the per-frame trajectory. Declared as a
// literal key list, not derived from OwnRunRecord's type, so a future field added to
// OwnRunRecord doesn't silently widen this without a deliberate edit here too.
type OtherRunRecord = Omit<OwnRunRecord, 'own' | 'samples'> & { own: false };

const OTHER_RUN_KEYS: ReadonlySet<string> = new Set([
	'own', 'file', 'horseIndex', 'buildKey', 'charaName', 'runningStyle',
	'skillsInBuild', 'skillsActivated', 'skillsPinned', 'skillLevelMean', 'skillLevelMax',
	'blockedFrameCount', 'temptationFrameCount', 'temptationModeMax',
	'realFinishOrder', 'realFinishTime', 'simFinishTime', 'simDistAtRealFinish', 'finishPosErrBasinn',
	'realHp0', 'simMaxHp', 'realLastSpurtStartDistance', 'simLastSpurtTransition',
	'simFullSpurt', 'simNonFullSpurtDelayDistance',
	'distErrMeanM', 'distErrRmsM', 'speedErrMeanMs', 'speedErrRmsMs', 'hpErrMean', 'hpErrRmsM',
]);

type RunRecord = OwnRunRecord | OtherRunRecord;

interface Manifest {
	filesScanned: number;
	filesFailed: {file: string; message: string}[];
	runsAttempted: number;
	// HorseDiffResult.skillsSkippedUnregisteredCondition is, as of the current replayDiff.ts,
	// only ever populated by a build() failure (see replayDiff.ts's catch block around
	// g.next()) -- there is no other "skill skipped but the horse still built" case today.
	// This field is that same information; don't add a separate manifest counter that would
	// just duplicate it unless replayDiff.ts grows a genuine partial-skip case.
	runsBuildFailed: {file: string; horseIndex: number; message: string}[];
	// A horse can also end up with zero samples for a reason that isn't a build failure at
	// all: replayDiff.ts's per-sample guard (`if (t > realFinish) return`) skips every
	// sample if the replay's own realFinishTime falls before its first recorded frame
	// timestamp. Not currently reachable in the champions-meeting-10903 corpus (every
	// file's first frame is at t=0), but kept distinct from runsBuildFailed so a future
	// corpus with that shape doesn't get miscounted as "unknown build failure."
	runsZeroSamplesButBuilt: {file: string; horseIndex: number; message: string}[];
	duplicateActivationsCollapsed: number;
}

interface ReseedRunEntry {
	file: string;
	horseIndex: number;
	buildKey: string;
	simFinishTimes: (number | null)[];
	finishPosErrBasinn: (number | null)[];
}

interface CorpusReport {
	courseSetId: number;
	courseDistance: number; // meters -- so the analysis script doesn't have to hardcode/assume it
	manifest: Manifest;
	runs: RunRecord[];
	reseed?: {seeds: number; perRun: ReseedRunEntry[]};
}

function skillLevels(raceHorse: any): number[] {
	return ((raceHorse.responseHorseData.skill_array || []) as {level: number}[]).map(s => s.level);
}

function errorStats(r: HorseDiffResult) {
	const distErrs = r.samples.map(s => s.simDist - s.realDist);
	const speedErrs = r.samples.map(s => s.simSpeed - s.realSpeed);
	const hpErrs = r.samples.map(s => s.simHp - s.realHp);
	return {
		distErrMeanM: mean(distErrs), distErrRmsM: rms(distErrs),
		speedErrMeanMs: mean(speedErrs), speedErrRmsMs: rms(speedErrs),
		hpErrMean: mean(hpErrs), hpErrRmsM: rms(hpErrs),
	};
}

// Keys whose value is always drawn from the game's own small, fixed, public character
// roster (raceHorse[].charaName) -- never from player-controlled free-text input -- so a
// string-equality hit against a redacted trainerName/owner_trainer_name is definitionally
// coincidence, not a leak of that trainer's real identity. `charaName` is that field
// directly; `buildKey` is either the very same charaName value (own runs, which are
// permitted full real identity by design -- see this file's Privacy section) or the
// synthetic opaque `b<N>` cluster id (non-own runs, never derived from any player's real
// input either). A 60-race corpus surfaced why this matters for real: a genuinely
// different trainer had named their own account "Seiun Sky", which collided first with an
// own run's buildKey and then (after excluding own runs didn't fully fix it) with a
// non-own run's legitimately-shown charaName of the same game character. Widen this set
// only for a field with the same structural property (drawn from a small closed roster or
// a synthetic id, never free-text player input) -- never as a general-purpose way to
// silence a future real hit.
const NEVER_REDACTED_KEYS: ReadonlySet<string> = new Set(['charaName', 'buildKey']);

// Structural publish gate. Walks every string value reachable from `value` and throws if
// any equals a string in `redacted` -- equality, never substring, per the header comment
// above. Call this on the *whole* report object before writing it anywhere.
function assertNoRedactedStrings(value: unknown, redacted: ReadonlySet<string>, pathStr = '$'): void {
	if (typeof value === 'string') {
		if (redacted.has(value)) {
			throw new Error(`privacy gate: redacted string found in emitted output at ${pathStr}`);
		}
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((v, i) => assertNoRedactedStrings(v, redacted, `${pathStr}[${i}]`));
		return;
	}
	if (value != null && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) {
			if (NEVER_REDACTED_KEYS.has(k)) continue;
			assertNoRedactedStrings(v, redacted, `${pathStr}.${k}`);
		}
	}
}

function assertAllowlisted(record: OtherRunRecord): void {
	const keys = Object.keys(record);
	if (keys.length !== OTHER_RUN_KEYS.size || !keys.every(k => OTHER_RUN_KEYS.has(k))) {
		const extra = keys.filter(k => !OTHER_RUN_KEYS.has(k));
		const missing = [...OTHER_RUN_KEYS].filter(k => !keys.includes(k));
		throw new Error(`privacy gate: non-own run record key set mismatch -- extra=[${extra}] missing=[${missing}]`);
	}
}

function buildCorpusReport(dir: string, reseedSeeds: number): CorpusReport {
	const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();

	let courseSetId: number | null = null;
	let courseDistance: number | null = null;
	const manifest: Manifest = {
		filesScanned: 0, filesFailed: [], runsAttempted: 0, runsBuildFailed: [],
		runsZeroSamplesButBuilt: [], duplicateActivationsCollapsed: 0,
	};
	const runs: RunRecord[] = [];
	const reseedPerRun: ReseedRunEntry[] = [];

	// Non-own build identity: sequential opaque index, keyed privately on
	// (trainerName, trained_chara_id) -- see header comment. This map and its keys are
	// never emitted; only the opaque values are.
	const nonOwnBuildKeys = new Map<string, string>();
	let nextNonOwnBuildId = 0;
	function opaqueBuildKey(trainerName: string, trainedCharaId: number): string {
		const privateKey = `${trainerName}|${trainedCharaId}`;
		let key = nonOwnBuildKeys.get(privateKey);
		if (key == null) {
			key = `b${nextNonOwnBuildId++}`;
			nonOwnBuildKeys.set(privateKey, key);
		}
		return key;
	}

	const redactedStrings = new Set<string>();

	for (const f of files) {
		manifest.filesScanned++;
		const full = path.join(dir, f);
		let json: any, parsed: ParsedReplay, results: HorseDiffResult[];
		try {
			({json, parsed} = parseReplayFile(full));
			if (courseSetId == null) {
				courseSetId = json.raceCourseSet.id;
			} else if (json.raceCourseSet.id !== courseSetId) {
				throw new Error(`mixed courses in ${dir}: ${courseSetId} vs ${json.raceCourseSet.id} (${f}) -- this tool assumes one course per directory, matching measureDownhill.ts's convention`);
			}
			results = run(full);
		} catch (e) {
			manifest.filesFailed.push({file: f, message: (e as Error).message});
			continue;
		}

		const course = CourseHelpers.getCourse(courseSetId!);
		if (courseDistance == null) courseDistance = course.distance;
		const playerTrainerName = json.raceHorse[json.playerHorseIndex].trainerName;

		for (const r of results) {
			manifest.runsAttempted++;
			manifest.duplicateActivationsCollapsed += r.skillsDuplicateActivations;
			if (r.samples.length === 0) {
				// skillsSkippedUnregisteredCondition is only ever populated by a genuine
				// build() failure (replayDiff.ts's catch block) -- use it as the primary
				// discriminator instead of assuming samples.length===0 always means a
				// build failure. Number.isNaN(r.simMaxHp) is the structural cross-check:
				// it stays at its NaN initializer unless the post-race writeback
				// (replayDiff.ts:413) ran, which only happens on a real build.
				if (r.skillsSkippedUnregisteredCondition.length > 0) {
					manifest.runsBuildFailed.push({
						file: f, horseIndex: r.horseIndex,
						message: r.skillsSkippedUnregisteredCondition[r.skillsSkippedUnregisteredCondition.length - 1],
					});
				} else if (Number.isNaN(r.simMaxHp)) {
					// Neither signal fired -- genuinely unexplained, keep the old bucket
					// and fallback message rather than inventing a classification.
					manifest.runsBuildFailed.push({
						file: f, horseIndex: r.horseIndex, message: 'unknown build failure',
					});
				} else {
					manifest.runsZeroSamplesButBuilt.push({
						file: f, horseIndex: r.horseIndex,
						message: "realFinishTime before replay's first recorded frame -- solver built successfully",
					});
				}
				continue;
			}

			const raceHorse = json.raceHorse[r.horseIndex];
			const isOwn = raceHorse.trainerName === playerTrainerName;
			const levels = skillLevels(raceHorse);
			const finishPosErrBasinn = r.simDistAtRealFinish != null ? (r.simDistAtRealFinish - course.distance) / 2.5 : null;
			const errStats = errorStats(r);

			const shared = {
				file: f, horseIndex: r.horseIndex,
				charaName: r.name,
				runningStyle: r.runningStyle,
				skillsInBuild: r.skillsInBuild, skillsActivated: r.skillsActivated, skillsPinned: r.skillsPinned,
				skillLevelMean: mean(levels) ?? 0, skillLevelMax: levels.length ? Math.max(...levels) : 0,
				blockedFrameCount: r.blockedFrameCount, temptationFrameCount: r.temptationFrameCount, temptationModeMax: r.temptationModeMax,
				realFinishOrder: r.realFinishOrder,
				realFinishTime: r.realFinishTime, simFinishTime: r.simFinishTime,
				simDistAtRealFinish: r.simDistAtRealFinish, finishPosErrBasinn,
				realHp0: r.realHp0, simMaxHp: r.simMaxHp,
				realLastSpurtStartDistance: r.realLastSpurtStartDistance, simLastSpurtTransition: r.simLastSpurtTransition,
				simFullSpurt: r.simFullSpurt, simNonFullSpurtDelayDistance: r.simNonFullSpurtDelayDistance,
				...errStats,
			};

			if (isOwn) {
				runs.push({own: true, buildKey: r.name, samples: r.samples, ...shared});
			} else {
				redactedStrings.add(raceHorse.trainerName);
				if (raceHorse.responseHorseData.owner_trainer_name) redactedStrings.add(raceHorse.responseHorseData.owner_trainer_name);
				const buildKey = opaqueBuildKey(raceHorse.trainerName, raceHorse.responseHorseData.trained_chara_id);
				const otherRecord: OtherRunRecord = {own: false, buildKey, ...shared};
				assertAllowlisted(otherRecord);
				runs.push(otherRecord);
			}
		}

		// Re-seed pass, own runs only -- Headline A's within-build sim-RNG floor only needs
		// the own-trainer repeats (however many own builds/races the corpus has). Re-running
		// the whole 9-horse race M times per file is required for correct physics (blocking/
		// spot-struggle/dueling all read every horse's state -- see run()'s opts doc comment),
		// but re-parsing the file from disk and re-collecting non-own horses' samples on every
		// one of the M seeds is pure waste: this loop is ~99% of this script's total runtime
		// at the default M=100. Reuse this file's already-parsed {json, parsed} (100 parses ->
		// 1) and gate sample collection to just the own-horse indices (100x fewer DiffSample
		// allocations) -- neither changes which horses get built/stepped, so the physics, and
		// therefore simFinishTime/simDistAtRealFinish, are unaffected.
		// Captures simDistAtRealFinish (not just simFinishTime) per seed, so sigma_simRNG can
		// be measured directly in the same finishPosErrBasinn units as the headline itself,
		// rather than approximated from a finish-time spread via a speed conversion.
		if (reseedSeeds > 0) {
			const ownHorseIndices = json.raceHorse
				.map((rh: any, i: number) => rh.trainerName === playerTrainerName ? i : -1)
				.filter((i: number) => i !== -1);
			if (ownHorseIndices.length > 0) {
				const ownHorseIndexSet = new Set<number>(ownHorseIndices);
				const perHorse = new Map<number, {simFinishTimes: (number | null)[]; finishPosErrBasinn: (number | null)[]}>(
					ownHorseIndices.map((i: number) => [i, {simFinishTimes: [], finishPosErrBasinn: []}]));
				for (let seed = 0; seed < reseedSeeds; seed++) {
					const reseedResults = run(full, seed, {preParsed: {json, parsed}, sampleHorseIndices: ownHorseIndexSet});
					for (const i of ownHorseIndices) {
						const rr = reseedResults[i];
						const acc = perHorse.get(i)!;
						acc.simFinishTimes.push(rr.simFinishTime);
						acc.finishPosErrBasinn.push(rr.simDistAtRealFinish != null ? (rr.simDistAtRealFinish - course.distance) / 2.5 : null);
					}
				}
				for (const i of ownHorseIndices) {
					const acc = perHorse.get(i)!;
					reseedPerRun.push({
						file: f, horseIndex: i, buildKey: json.raceHorse[i].charaName,
						simFinishTimes: acc.simFinishTimes, finishPosErrBasinn: acc.finishPosErrBasinn,
					});
				}
			}
		}
	}

	const report: CorpusReport = {
		courseSetId: courseSetId ?? -1,
		courseDistance: courseDistance ?? -1,
		manifest, runs,
		...(reseedSeeds > 0 ? {reseed: {seeds: reseedSeeds, perRun: reseedPerRun}} : {}),
	};

	assertNoRedactedStrings(report, redactedStrings);
	return report;
}

function main() {
	const args = process.argv.slice(2);
	const dirArg = args.find(a => !a.startsWith('--'));
	if (!dirArg) {
		console.error('usage: ts-node corpusReport.ts <corpus-dir> [--reseed N]');
		process.exit(1);
	}
	const reseedFlagIdx = args.indexOf('--reseed');
	const reseedSeeds = reseedFlagIdx !== -1 ? parseInt(args[reseedFlagIdx + 1], 10) : 100;

	const report = buildCorpusReport(dirArg, reseedSeeds);
	process.stdout.write(JSON.stringify(report));
	process.stdout.write('\n');

	if (report.manifest.filesFailed.length > 0) {
		console.error(`${report.manifest.filesFailed.length} file(s) failed to parse:`);
		for (const f of report.manifest.filesFailed) console.error(`  ${f.file}: ${f.message}`);
	}
	console.error(`corpusReport: ${report.manifest.filesScanned} files scanned, ${report.manifest.runsAttempted} runs attempted, ${report.manifest.runsBuildFailed.length} build failures, ${report.manifest.runsZeroSamplesButBuilt.length} zero-sample-but-built, ${report.manifest.duplicateActivationsCollapsed} duplicate activations collapsed`);
}

if (require.main === module) {
	main();
}

export { buildCorpusReport, assertNoRedactedStrings, OTHER_RUN_KEYS };
