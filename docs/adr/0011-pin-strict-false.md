# ADR-0011: `tsconfig.json` pins `"strict": false` rather than inheriting TypeScript 7's default

**Status:** Accepted
**Date:** 2026-09-05 (PIPE-53)

## Context

PIPE-53 synced this repo's compiler to the parent's: `typescript ^4.7.4 → ^7.0.2` and
`@types/node ^18 → ^24`. The bump itself is mechanical, but it carries a behavioural change that
has nothing to do with either version number.

**TypeScript 4.7 defaults `strict` off. TypeScript 7.0.2 defaults it on.** This repo's
`tsconfig.json` had never set the key — it was written against 4.7 and inherited the off default
implicitly, so nobody ever chose it. Bumping the compiler would therefore have silently enabled
`strictNullChecks`, `noImplicitAny` and `strictPropertyInitialization` as a side effect of a
version bump.

Measured on the toolchain this decision actually ships — `typescript@7.0.2` with
`@types/node@24.13.3` installed — same working tree and same `tsconfig.json` each time:

| Compiler | `strict` | Errors |
|---|---|---|
| 4.7.4 (before) | off by default | 7 |
| 7.0.2 | on by default | **284** |
| 7.0.2, `strict: false` | off | 7 |

The 284 includes the 7 pre-existing baseline errors, so **277 are net-new strict findings**. By
code: 86 × TS7006, 48 × TS7053, 37 × TS7005, 29 × TS2345, 22 × TS7034, 14 × TS2564, 14 × TS2531,
8 × TS18047, 5 × TS18048, 4 × TS7023, 4 × TS2322, 3 × TS2561, 3 × TS2339, 2 × TS2769, 2 × TS2554,
and one each of TS7051 / TS7017 / TS2366. By area: `tools/` 163, `test/` 52, engine core 69, with
`tools/basinnhyou.ts` (47), `RaceSolverBuilder.ts` (29), `tools/gain.ts` (28) and `tools/dump.ts`
(28) the heaviest single files.

An earlier figure of 88 circulated during PIPE-53's planning and appears in some ticket text. It
was measured against `@types/node@18` before the bump resolved, and does not reproduce on the
installed toolchain — 284 is the reproducible number, and the one this decision rests on.

## Decision

Pin `"strict": false` explicitly in `tsconfig.json`, making the previously-implicit default a
stated one, and keep PIPE-53 to a pure compiler sync with an unchanged 7-error baseline. Adopting
strict is tracked separately as PIPE-59.

The key is added as a plain JSON entry with no comment: esbuild resolves the nearest
`tsconfig.json` for this repo's sources when the parent builds its bundles, and while esbuild does
accept JSONC, there is no reason to depend on that when the rationale belongs in a document like
this one.

## Rejected alternatives

**Accept the default and fix all 284 in PIPE-53.** The findings are real and worth fixing, but 69
of them sit in code whose output is numerically sensitive. The mechanical repairs strict mode invites
— a non-null assertion, a `?? 0`, a widened parameter type — are exactly the edits that can change
a simulated result while still compiling. `test/regression/check.ts`'s golden master is the only
thing that would catch that, and subjecting it to hundreds of unrelated edits bundled inside a version bump
is the wrong way to spend it. This would also have converted a three-line config change into a
large engine diff, making the compiler sync itself hard to review.

**Leave the key unset, matching the parent's `tsconfig.json` literally.** Config parity, and it
would have recorded 284 as the new baseline. Rejected because a 284-error floor makes this repo's
own "don't introduce new errors in files you touch" rule unenforceable in practice — nobody
reliably distinguishes their own new TS2531 from the 14 already there.

**Enable strict flag-by-flag inside PIPE-53.** Correct end state, wrong ticket: it makes a
toolchain sync depend on completing an unrelated multi-pass refactor.

## Consequences

- The compiler advanced two major generations with **zero source changes** and an unchanged error
  baseline. Two codes shifted: the two `pacer` object-literal errors report as `TS2561` under TS 7
  (with a "Did you mean to write `isPacer`?" suggestion) where 4.7.4 reported `TS2345`.
- Strict adoption is deferred, not abandoned. Its cost is larger than early planning assumed —
  277 net-new findings, not 80 — which strengthens rather than weakens the case for keeping it out
  of a version bump. PIPE-59 tracks it, recommending
  `noImplicitAny` → nullability → `strictPropertyInitialization`, each as its own pass verified
  against the golden master.
- **This pin does not make engine sources strict-free everywhere.** `mackoz/uma-tools`'s
  `tsconfig.json` declares no `include`/`exclude`, so its own `tsc --noEmit` walks into
  `uma-skill-tools/` and checks these same files under the *parent's* config — 285 of that repo's
  1007 diagnostics are engine-prefixed. That was equally true before this ADR; the pin changed
  nothing there. It does mean the engine-side and parent-side strict decisions are coupled, and
  either one landing changes the other's numbers.
- The parent repo carries the same unchosen default for its own sources, tracked as PIPE-58.
