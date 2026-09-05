# ADR-0012: Vitest for unit test files; CLI harnesses stay on `tsx`

**Status:** Accepted
**Date:** 2026-09-05 (PIPE-50)

## Context

Before PIPE-50, this engine ran nine test entry points as sequential `tsx` invocations chained in
`package.json`'s `test` script, asserting via `tape`: seven unit files (`test/parser.ts`,
`test/activation-sampling.ts`, `test/rushed-escape-roll.ts`, `test/spot-struggle-duration.ts`,
`test/spot-struggle-group.ts`, `test/activate-counts-as-random.ts`, `test/value-scaling-roll.ts`),
plus two CLI harnesses (`test/race.ts -n 500`, `test/regression/check.ts --fast`). Each unit file
paid a full re-transpile per invocation, there was no shared runner, and `mackoz/uma-tools` (the
parent repo) had already been on Vitest 5 since PIPE-41 — the engine submodule was the one place
in the project still on `tape`. A Vitest runner attached to the engine is also a prerequisite for
work this repo wants later: `@vitest/coverage-v8`, Stryker mutation testing, and
`toMatchFileSnapshot` golden masters all need it, none of which existed on the `tape` chain.

Two things structurally cannot move onto Vitest, and don't try to:

- **`test/regression/check.ts` and `test/regression/knowncases.ts` both import `tape` directly**,
  and `check.ts` monkey-patches `Test.prototype.almostEqual`. Rewriting the regression harness's
  own assertion machinery was out of scope for a test-runner migration — `tape` stays a
  devDependency for these two files alone.
- **`RaceSolverBuilder.ts:758` does a lazy `require('./ActivationSamplePolicy')`** inside a path
  the CLI harnesses (`race.ts`, `regression/check.ts`) can reach but no migrated unit test does.
  CommonJS `require` is not reliably defined under Vitest's runner (it runs sources through esbuild
  as ESM), so folding the harnesses into Vitest risked breaking that path for no benefit — the unit
  files never touch it.
- **`test/race.ts` itself cannot import anything that imports `vitest`.** It's a standalone
  `commander`-driven CLI script invoked directly via `tsx`, never through the Vitest runner. `tsx`
  transpiles this package's import graph as CommonJS (no `"type": "module"` in `package.json`), and
  `vitest`'s package refuses to be `require()`'d — discovered empirically when a first pass put the
  shared `prop()` test-registration helper (used by `test/parser.test.ts` and the newly-adopted
  `test/course-helpers.test.ts`) in the same module `race.ts` already imported for `forAll()`. The
  fix was structural, not a workaround: `test/TestHelpers.ts` keeps only the framework-free
  `forAll()` that `race.ts` needs, and the Vitest-dependent `prop()` wrapper moved to its own
  `test/VitestProp.ts`, imported only by the `*.test.ts` files that run under Vitest. `race.ts`
  carries a small local `prop()` of its own that reports to the console and sets
  `process.exitCode` on failure, preserving the pre-migration behavior of failing `npm test`'s
  `&&`-chain on a real property failure.

## Decision

Migrate the seven unit files to Vitest 5 (`git mv` to `*.test.ts`, `tape` assertions rewritten
onto `node:assert/strict` matching the parent's own PIPE-41 style: `t.equal`→`strictEqual`,
`t.notEqual`→`notStrictEqual`, `t.ok(x,m)`→`ok(x,m)`, `t.notOk(x,m)`→`ok(!x,m)`,
`t.deepEqual`→`deepStrictEqual`), and adopt the orphaned `test/helpers.ts` (a real
`CourseHelpers.isSortedByStart()` property test that `npm test` had never actually run) as
`test/course-helpers.test.ts` — fixing its synchronous-hang shuffle loop on adoption rather than
preserving a defect nothing had ever exercised. `vitest.config.mts` mirrors the parent's shape
(`test.include: ['test/**/*.test.ts']`, `environment: 'node'`, no `globals`).
`package.json`'s `test` script becomes `vitest run && tsx test/race.ts -n 500 && tsx
test/regression/check.ts --fast` — the two CLI harnesses stay exactly where PIPE-52 left them.

The mapping from `tape` to `node:assert/strict` is checked against `tape`'s own source, not
assumed: `tape` depends on `object-is` and its `deepEqual` already passes `{strict: true}`
(`lib/test.js`), so `t.equal`/`assert.strictEqual` and `t.deepEqual`/`assert.deepStrictEqual` agree
exactly except at `NaN`/`-0`, which no migrated assertion compares.

## Rejected alternatives

**`node:test`.** Also a real option and also not what the parent repo uses. Vitest wins on
consistency with `mackoz/uma-tools` (one test-runner mental model and config shape across both
repos in this project) and on the coverage/mutation/snapshot tooling this repo wants attached next,
none of which `node:test` provides out of the box.

**Fold the CLI harnesses (`race.ts`, `regression/check.ts`) into Vitest too.** Rejected on three
independent grounds, any one of which would have been enough on its own: `check.ts`'s `tape`
prototype patching (`Test.prototype.almostEqual`) has no Vitest equivalent to port to without
rewriting the regression harness's own assertion internals; `commander`'s `program.parse()` +
`process.argv` handling doesn't map cleanly onto how Vitest collects and runs a suite; and the lazy
`require('./ActivationSamplePolicy')` at `RaceSolverBuilder.ts:758` sits on a path only the
harnesses reach, which Vitest's ESM-via-esbuild runner cannot reliably support.

## Consequences

- The engine's unit tests now share Vitest's runner, config shape, and reporter with
  `mackoz/uma-tools` itself, closing the one asymmetry PIPE-41 left in this project's test tooling.
- `tape` and `@types/tape` remain devDependencies, scoped down to exactly two files
  (`test/regression/check.ts`, `test/regression/knowncases.ts`) instead of nine.
- `test/TestHelpers.ts` and `test/VitestProp.ts` are now two files instead of one, a direct
  consequence of `race.ts`'s hard constraint against importing anything that imports `vitest`. A
  future unit test needing `prop()` imports it from `VitestProp.ts`; a future CLI harness needing
  `forAll()` keeps importing from the framework-free `TestHelpers.ts`.
- `test/course-helpers.test.ts` is a genuinely new addition to the executed test surface (0 → 2
  property-test blocks), not a like-for-like migration — it had never run before this ticket. Its
  shuffle-loop hang fix (`if (new Set(xs).size < 2) return true;` guarding an
  all-equal-input infinite loop) is a test-file fix, not an engine behavior change:
  `CourseHelpers.isSortedByStart()` itself is untouched.
- `@vitest/coverage-v8`, Stryker mutation testing, `toMatchFileSnapshot` golden masters, broader
  `fast-check` property tests, component tests, and `knip` remain deliberately out of scope — each
  is its own future ticket, unblocked but not started by this one.
