#!/usr/bin/env node
// PIPE-50: proves a refactor (e.g. a tape -> vitest test migration) touched no numeric literal.
// For each {base-ref, old-path, new-path} triple, extracts every numeric literal from the file's
// text at base-ref and from the current working tree, sorts both multisets, and asserts they are
// identical. A rename/API-surface rewrite changes no numbers; any difference reported here is a
// real bound/seed/constant change and must be investigated, not silenced.
//
// Usage: node scripts/check-no-constant-drift.mjs <base-ref> <old-path>:<new-path> [<old-path>:<new-path> ...]
// Example:
//   node scripts/check-no-constant-drift.mjs a1668dd \
//     test/spot-struggle-group.ts:test/spot-struggle-group.test.ts \
//     test/parser.ts:test/parser.test.ts
//
// Kept intentionally general (base ref + explicit old:new path pairs) so it can be reused for a
// future refactor, not just this migration.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const NUMBER_RE = /-?\d+\.?\d*(?:[eE][+-]?\d+)?/g;

function extractNumbers(text) {
	return (text.match(NUMBER_RE) || []).map(Number).sort((a, b) => a - b);
}

function multisetDiff(a, b) {
	// symmetric difference by value, tolerant of repeats (a simple sorted-array diff)
	const extraInA = [];
	const extraInB = [];
	let i = 0, j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) { i++; j++; }
		else if (a[i] < b[j]) { extraInA.push(a[i]); i++; }
		else { extraInB.push(b[j]); j++; }
	}
	while (i < a.length) extraInA.push(a[i++]);
	while (j < b.length) extraInB.push(b[j++]);
	return { extraInA, extraInB };
}

function main() {
	const [baseRef, ...pairs] = process.argv.slice(2);
	if (!baseRef || pairs.length === 0) {
		console.error('usage: check-no-constant-drift.mjs <base-ref> <old-path>:<new-path> ...');
		process.exit(2);
	}

	let anyFailed = false;

	for (const pair of pairs) {
		const [oldPath, newPath] = pair.split(':');
		if (!oldPath || !newPath) {
			console.error(`malformed pair (expected old:new): ${pair}`);
			anyFailed = true;
			continue;
		}

		let oldText;
		try {
			oldText = execFileSync('git', ['show', `${baseRef}:${oldPath}`], { encoding: 'utf8' });
		} catch (e) {
			console.error(`FAIL ${oldPath} -> ${newPath}: could not read ${oldPath} at ${baseRef}: ${e.message}`);
			anyFailed = true;
			continue;
		}

		let newText;
		try {
			newText = readFileSync(newPath, 'utf8');
		} catch (e) {
			console.error(`FAIL ${oldPath} -> ${newPath}: could not read ${newPath}: ${e.message}`);
			anyFailed = true;
			continue;
		}

		const oldNums = extractNumbers(oldText);
		const newNums = extractNumbers(newText);
		const { extraInA, extraInB } = multisetDiff(oldNums, newNums);

		if (extraInA.length === 0 && extraInB.length === 0) {
			console.log(`OK   ${oldPath} -> ${newPath} (${oldNums.length} numeric literals, unchanged)`);
		} else {
			anyFailed = true;
			console.error(`FAIL ${oldPath} -> ${newPath}: numeric literal multisets differ`);
			console.error(`  only in ${oldPath} (base ${baseRef}): ${JSON.stringify(extraInA)}`);
			console.error(`  only in ${newPath} (working tree):    ${JSON.stringify(extraInB)}`);
		}
	}

	process.exit(anyFailed ? 1 : 0);
}

main();
