# ADR-0010: `conditionsWithActivateCountsAsRandom` now shadows `is_activate_any_skill`

**Status:** Accepted
**Date:** 2026-09-03 (UI-34)

## Context

`RaceSolverBuilder.ts`'s `conditionsWithActivateCountsAsRandom` (`withActivateCountsAsRandom()`)
exists so a caller who equips a horse with only *some* of its skills can still get a plausible
activation for a skill whose trigger requires a prior skill activation — the six `activate_count_*`
condition names are shadowed with region-modeling or unconditional-satisfaction stand-ins instead
of the base table's literal `RaceState.activateCount*` counter checks, which can only move if a
second skill actually fires during the simulated race.

`is_activate_any_skill` is the same class of problem — its base implementation
(`ActivationConditions.ts`) is `s.activateCountLastFrame > 0`, true only the frame after *some
other* skill has activated — but it wasn't in the shadowed table. `uma-tools`' Course Chart
(UI-34) equips each candidate with only its own native unique by design, so any unique gated on
this condition (e.g. Global's `120011`, Dreams Donned with Pride!) simulated a full race and never
activated, reading a permanent 0% proc.

## Decision

Add `is_activate_any_skill: noopImmediate` to `conditionsWithActivateCountsAsRandom`.

`noopImmediate`, not the region-sampled `random({filterGte...})` shape most of the six
`activate_count_*` neighbors use (`activate_count_all`/`_end_after`/`_later_half`/`_middle` model a
*count/distance threshold* — e.g. "activated a skill in the middle phase at least twice" — with a
random sampling window over a plausible region; only `activate_count_heal` is a plain `noopRandom`
like this entry's sample policy, and `activate_count_start` is `immediate` outright).
`is_activate_any_skill` has no threshold to sample against — its base form is an instantaneous
per-frame check with no distance component at all — so treating it as unconditionally satisfied (an
`Immediate` trigger, full course region) matches its own semantics more closely than inventing a
sampling window would.

Checked before committing to this: every unique in either the JP or Global dataset currently using
`is_activate_any_skill` also carries its own phase/corner/style clauses in the same alternative
(e.g. `120011`'s `phase>=2&is_finalcorner==1&corner!=0`). Those clauses still apply under the
shadowed table — only `is_activate_any_skill` itself becomes unconditional — so this doesn't
degenerate into "fires at the start line" for any skill actually exercising this path today.

## Options considered

- **Model it the same way as `activate_count_all`'s `n == 7` fast-path** (a narrow region near
  where the game would plausibly have already fired something). Rejected: `is_activate_any_skill`
  has no `n` to key a heuristic off of, and there's no equivalent "conveniently the only two skills
  with this shape" narrowing available — an invented window would be a bigger unverified claim than
  "unconditionally satisfied, bounded by the skill's own other clauses."
- **Leave it unshadowed and accept the 0% reading.** Rejected — this is exactly the gap UI-34 set
  out to close for the six `activate_count_*` names, and leaving one condition name out for no
  principled reason would just relocate the same bug to a different set of skills.

## Consequences

- Any skill gated on `is_activate_any_skill` and simulated under `withActivateCountsAsRandom()`
  (currently: `uma-tools`' Course Chart only, plus the `basinnhyou.ts` CLI tool if it ever equips a
  horse with a subset of skills gated this way) now activates deterministically once its other
  clauses are satisfied, instead of never activating. This is a **coarser** approximation than a
  region-sampled condition — it's "always true," not "true with some modeled probability" — so a
  chart or tool consuming this should surface that the activation point is approximated, not exact
  (see `uma-tools`' UI-34 for the app-side badge that does this).
- The base `Conditions` table (the real `s.activateCountLastFrame > 0` dynamic check) is completely
  unaffected — this shadow only applies to callers that explicitly opt into
  `withActivateCountsAsRandom()`.
