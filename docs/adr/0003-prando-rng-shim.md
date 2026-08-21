# ADR-0003: `Rule30CARng` is a prando-backed shim, not a Rule-30 generator

**Status:** Inherited (rationale reconstructed)
**Date recorded:** 2026-08-21 (inherited via the kachi-lineage import, `9c0652a`)

## Context

Upstream `uma-skill-tools` has a `Rule30CARng` class that is a genuine Rule-30 cellular-automaton PRNG. A large amount of code across the engine constructs RNGs by that name. The kachi lineage this fork imported replaced the implementation while keeping the name.

## Decision

`Random.ts` defines `SeededRng`, a thin wrapper over the [`prando`](https://www.npmjs.com/package/prando) library, and aliases it: `export const Rule30CARng = SeededRng;` (`Random.ts:44`). Every call site keeps compiling unchanged; none of them get a Rule-30 generator.

## Options considered

- **Keep upstream's real Rule-30 implementation.** Rejected somewhere in the kachi lineage; the surviving evidence doesn't record the author's reason. A defensible one is quality-of-implementation: a library PRNG with known behavior over a bespoke CA generator.
- **Rename every call site to `SeededRng`.** Not taken — the alias is the entire migration. Cheap, but it left a name that actively lies (see Consequences).

## Consequences

- **Numeric output differs from upstream for identical seeds.** No cross-engine "same seed, same result" comparison against upstream (or any real Rule-30 implementation) is valid. This has caused confusion before; it's also `CLAUDE.md` hard rule 3.
- The misleading name is a standing trap for anyone reading the code with upstream assumptions. Kept (for now) because the alias touches every RNG construction site and the rename has never been worth the diff noise on its own.
- `prando`'s statistical quality is adequate for this engine's Monte-Carlo use but unremarkable; if the generator is ever revisited, the alias means it's a one-line swap — which is the one genuine benefit of the current shape.
- `deriveSeed` (ADR-0005) was later added alongside the shim and is independent of the underlying generator.
