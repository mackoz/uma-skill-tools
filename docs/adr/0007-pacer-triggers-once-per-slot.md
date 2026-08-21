# ADR-0007: Pacer skill triggers sampled once per slot, not per scenario

**Status:** Accepted
**Date:** 2026-08-20 (`0861c8f`)

## Context

From the commit's own record: `buildPacer` called `setupPacerSkillTriggers` on every invocation, "which resampled the full nsamples-length trigger table for every pacer skill just to read one index of it (`i % length`). Called once per pacemaker per scenario, that made pacer trigger sampling cost O(nsamples²) instead of O(nsamples) — invisible at the old ~125-sample chart cap, a measurable +13% at nsamples=1600, and the dominant cost at anything higher." The statistical chart's move to much larger sample counts is what exposed it.

## Decision

Split setup from use: `prepPacerTriggers(pacerSlots, baseSeed)` samples each pacemaker slot's full trigger table **once, before the scenario loop**, seeding each slot and skill independently via `deriveSeed(baseSeed, "pacer-triggers:slot")` then `deriveSeed(triggerSeed, "key:occurrence")` (ADR-0005's identity-seeding pattern). `buildPacer` only indexes the precomputed table. Slots stay distinct — multiple simultaneous pacemakers keep seeing different trigger positions from each other, preserving prior behavior.

## Options considered

- **Cache inside `buildPacer` lazily.** Functionally similar, but hides a numeric-output-affecting setup step inside what looks like a pure constructor; the explicit prep call makes the caller's responsibility (and the seeding boundary) visible.
- **One shared table across slots.** Cheaper still, but changes behavior — simultaneous pacemakers would proc identically.
- **Leave it.** The +13% was tolerable at 1600 samples but the asymptote wasn't; the chart's ladder goes well past that.

## Consequences

- Pacer trigger sampling is O(n); the quadratic term is gone from chart runs.
- **This is a genuine numeric-output change** for any race with pacer skill triggers: scenario *i* now takes index *i* of one fixed-seed stream per slot, instead of a stream reseeded fresh every scenario from the RNG chain that also drives pacer solver construction. It brings pacer triggers in line with how the main horses' own triggers already worked. When diffing simulator output against a pre-`0861c8f` run with a virtual pacemaker involved, expect a difference — that's this fix, not a regression (also flagged in `CLAUDE.md`'s hard rules).
- `prepPacerTriggers` must be called before the scenario loop by any consumer that uses pacer skills; the umalator's `compare.ts` is currently the one caller.
