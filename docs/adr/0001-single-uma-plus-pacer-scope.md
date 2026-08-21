# ADR-0001: Simulate a configured handful of umas, not a full live-read field

**Status:** Inherited (rationale reconstructed)
**Date recorded:** 2026-08-21 (layered decision: alpha123's engine was strictly single-uma; the kachi-lineage import `9c0652a` added multi-uma machinery; this fork's consumer uses it for a compared pair plus virtual pacemakers)

## Context

A real race has up to 18 runners whose positions, lanes, and interactions (blocking, vision, proximity-triggered skills, debuff targeting, live standings) all affect the outcome. Simulating that faithfully needs per-runner builds the user mostly can't supply, plus cross-runner geometry and coordination. This engine's purpose, inherited from alpha123, is narrower: estimate the *value of a skill or a build for one uma* — "how many bashin does this gain me on this course?" — across many randomized scenarios.

The scope decision has two layers with different ancestries:

1. **alpha123** (`alpha123/uma-skill-tools`) simulated exactly one uma; everything field-dependent was faked.
2. **The kachi lineage** (Werseter's branch, imported at `9c0652a`) added genuine multi-uma machinery: `initUmas()` builds a `RaceSolver[]` where each uma sees the others, `getPacer()` re-elects the pacemaker every frame, and position keep, lane movement, and dueling/lead-competition operate across the simulated group.

## Decision

The engine simulates **the umas the user configures — in practice a compared pair plus virtual pacemakers — with real relative positions among them, but it does not simulate a full field, and it does not read field-interaction state live** even among the umas it does simulate:

- `order`/`order_rate` conditions check against a fixed, user-supplied placement assumption (`extra.orderRange`), not the simulated group's actual standings each frame (see `README.md`, "Whole-field simulation").
- Blocking, vision, surrounded/near-count and similar interaction conditions are never derived from the simulated umas' geometry — they are probability stand-ins (ADR-0002), uncorrelated with where anyone actually is.
- The virtual pacemaker exists to give position-keeping a real gap target and to stand in as "the uma ahead" for front-runner checks; it is not an opponent build.

## Options considered

- **Full-field simulation with live-read interactions.** Rejected (implicitly, at each layer): the input problem — 8–17 opponent builds the user can't supply — undermines the tool's question, and the modeling cost (blocking geometry, lane interaction, per-frame standings) is an order of magnitude beyond the pair-comparison need. Sibling projects that went this way confirm both the power and the cost of that road.
- **Strictly one uma, no group at all** (alpha123's original shape). Superseded by the kachi import: position-keeping, dueling, and pacer election are meaningless without at least a small group, and the pair comparison needs both arms in one race.
- **Live-reading `order` and interaction conditions from the simulated pair+pacers.** Not taken: a 2–4 uma group's standings are not a meaningful stand-in for an 18-runner field's, so a fixed user assumption (`orderRange`) was judged less misleading than a live read of an unrepresentative group. (Reconstructed; this is the one piece of this decision with genuine room for debate.)

## Consequences

- Skill-EV comparisons stay cheap and the input burden stays at one build (plus pacer settings).
- Everything interaction-dependent rests on the ADR-0002 stand-ins, even though a small simulated group exists that could in principle be measured.
- Mechanics that structurally require knowing the whole field's composition (the 1.5-anniversary Pace Up Ex mode, the solo-front-runner speed-up threshold) cannot be implemented.
- The `orderRange` assumption is a user-visible modeling knob: conclusions about order-conditional skills are conditional on it.
