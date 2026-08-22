# ADR-0005: Per-skill derived RNG streams (`deriveSeed`)

**Status:** Accepted
**Date:** 2026-08-20 (`bd95b39`, "stabilize statistical sampling")

## Context

The solver consumes randomness for many purposes: skill wisdom rolls, skill trigger placement, per-section speed variation, rushed checks, downhill mode, position-keep rolls, and more. When all of these draw from one sequential stream, the streams are *coupled*: adding, removing, or reordering one skill shifts every subsequent draw. In an A/B comparison ("this build with skill X vs without it"), that coupling means the two arms don't just differ by X — they experience entirely different luck, inflating the variance of exactly the difference being measured. The statistical Skill Chart runs thousands of such paired comparisons, so this coupling was a first-order noise source.

## Decision

Randomness is split into purpose-specific streams, and skill-related draws are seeded **by identity, not by sequence**:

- `deriveSeed(seed, key)` (`Random.ts`) hashes a string key into a 32-bit seed — FNV-1a over the key, then a MurmurHash3 finalizer; the code comments record both intents: "Derive a stable 32-bit seed without consuming another random stream" and "avoids weak seeds for similar skill IDs".
- Each skill's **wisdom roll** uses a fresh RNG seeded by `deriveSeed(skillWisdomSeed, "skillId:perspective:triggerStart:triggerEnd")` (`RaceSolver.ts` `checkWisdomForSkill`).
- Each skill's **trigger positions** are sampled from a fresh RNG seeded by `deriveSeed(skillTriggerSeed, "key:occurrence")` (`RaceSolverBuilder.ts:858`; same pattern for pacer slots at `:576-583`).
- **Section speed randomness** gets its own dedicated `sectionSpeedRng`, and the solver's other consumers (`syncRng`, `gorosiRng`, `rushedRng`, `posKeepRng`, `laneMovementRng`, per-slope downhill RNGs) each get their own stream seeded once from the master RNG.

The result is common-random-numbers by construction: for a fixed scenario seed, skill X's rolls are a pure function of X's identity, so build A and build B share every draw except the ones belonging to skills that actually differ.

## Options considered

- **One shared sequential stream** (the inherited behavior): simplest, but couples everything to everything; rejected as the direct cause of the chart's sampling instability.
- **Common-random-number pairing at the tool level only** (pair scenario seeds across arms, keep the shared stream inside the solver): helps batch tools, but any consumer that doesn't implement the pairing loses the property, and within-scenario coupling from skill-set differences remains. Rejected in favor of fixing it in the engine, once, for every consumer.

## Consequences

- Paired comparisons are dramatically lower-variance; the Skill Chart's confidence intervals shrink accordingly and its eliminations became stable run-to-run.
- **Numeric output changed** relative to pre-`bd95b39` versions for any seeded run — expected, not a regression.
- The seed-key format (`skillId:perspective:start:end`) is load-bearing: changing it silently reshuffles every skill's luck. Treat key-format changes as numeric-output changes.
- Streams are only as independent as the hash — the MurmurHash3 finalizer exists precisely because nearby skill IDs otherwise produced correlated prando seeds.
