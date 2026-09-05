import { test } from 'vitest';

// PIPE-50: split out of TestHelpers.ts because TestHelpers.ts (specifically its forAll()) is also
// imported by test/race.ts, a standalone CLI harness run directly via `tsx`, never through the
// vitest runner. Importing vitest's `test` at module scope there crashes (`tsx` transpiles the
// import graph to CommonJS in this package -- no "type": "module" -- and vitest refuses to be
// require()'d). Keeping this vitest-dependent wrapper in its own module means TestHelpers.ts stays
// framework-free and safe for race.ts to import, exactly as before this migration.
export function prop(msg: string, f: () => void) {
	test(msg, () => {
		f();
	});
}
