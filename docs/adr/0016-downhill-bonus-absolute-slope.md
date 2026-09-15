# ADR-0016: Downhill accel-mode bonus uses the slope's absolute value, diverging from the imported KuromiAK doc

**Status:** Accepted
**Date:** 2026-09-14 (SPD-7)

## Context

This engine's downhill accel-mode speed bonus was `0.3 + slopePer / 100000.0`
(`RaceSolver.ts@downhill-accel-bonus-formula`). `slopePer` is the raw course-data slope value,
which is negative on a downhill (`-10000` for a 1% grade), and the branch is reachable only when
`slopePer < 0`. So the bonus *shrank* as the slope got steeper — 0.2 m/s at 1%, 0.1 at 2%, exactly
0 at 3%, negative beyond — for a mechanic named "downhill **accel** mode".

That formula was a faithful port of this project's imported reference,
`plans/game-mechanics/stats-and-speed.md` ("Uma Musume Race Mechanics", by KuromiAK), which gives
`0.3 + SlopePer/10` in units where `SlopePer = slopePer / 10000`. The engine was not
misimplementing its source; the source itself carried the error.

The question had been open since 2026-08-25 and was explicitly gated on evidence: three
third-party implementations independently used the slope's absolute value — hakuraku's
`raceConstants.ts`, `mee1080/umasim`'s `RaceState.kt:254`, and `Tunnelbliick/umacalc`'s
`src/simulator/simulator.ts` (`Math.abs(currentSlope) / 10 + 0.3`, under a comment reading
"steeper decline = more speed") — but a cross-implementation survey is not measurement, and a
doc-vs-doc disagreement was judged too weak to flip a numeric constant on.

Worth noting in hindsight: `umacalc`'s author is one of the two people credited with building
the server-side reimplementation that ultimately settled this, so that 2024 implementation was
already correct two years before we could verify it. A prior attempt to settle it from real replay data (PIPE-21) was inconclusive, and a
corrected re-run of that measurement actively pointed the *wrong* way — see Consequences.

What changed is the evidence available. On 2026-09-13 hakuraku shipped `/racedata` resimulation
backed by a reverse-engineered reimplementation of the game's **server-side** race simulator
(`engineBuild: rust-v1.0.4`), whose output matches the real server race. Its shared-race payload
(`/api/share/<id>`) exposes `detailedSimulation.annotations`: an explicit mode-flag legend
(`downhill: 32`), exact per-horse downhill-mode spans, and a per-sample `targetSpeeds` series.

Because the bonus is applied to *target* speed, it appears in that series as a step at each
downhill span boundary, with no inference required.

## Decision

Use the absolute value:

```ts
this.targetSpeed += 0.3 + Math.abs(this.slopePer) / 100000.0;
```

The bonus now grows with steepness: 0.4 / 0.5 / 0.6 m/s at 1% / 2% / 3% grades.

This **deliberately diverges from the imported KuromiAK doc**, which is a departure from how
`plans/game-mechanics/README.md` had previously said to treat that import (source-faithful,
re-import rather than hand-patch). The project owner's ruling (2026-09-14) is that these docs are
free to diverge from the KuromiAK original where the original is factually wrong; the goal is
factual correctness, not source fidelity. `stats-and-speed.md` was corrected in the same pass.

### Evidence

Measured on course **10808** (Kyoto turf 2200m), whose only downhill is `slope: -20000` — a 2%
grade, where the two candidate formulas are furthest apart:

| Formula | Predicted bonus at 2% |
|---|---|
| `0.3 + slopePer/100000` (previous) | **0.100** |
| `0.3 + \|slopePer\|/100000` (adopted) | **0.500** |

Across three independent seeds (1055713571, 1682909958, -2138859178), **26 unconfounded
downhill-span boundaries in `targetSpeeds` stepped by exactly 0.50000**. The previous formula's
0.100 occurred **zero** times. "Unconfounded" means no other state span, skill activation, or
last-spurt decision fell in the sampling window; the handful of excluded boundaries all stepped
by *more* than 0.5 (consistent with a section-boundary `baseTargetSpeed` shift stacking on the
bonus) and never less.

## Rejected alternatives

- **Keep the signed formula, treat the reference doc as authoritative.** Rejected: the doc is a
  community reverse-engineering effort that explicitly disclaims guaranteed correctness, and a
  simulator that reproduces server output is strictly better evidence about server behaviour than
  a prose description of it.
- **Flip on the cross-implementation survey alone** (hakuraku, umasim and umacalc all using `abs`).
  Rejected at the time, and correctly: agreement between two third-party implementations is not
  evidence about the game, and a third implementation (`jalbarrang/torena-sim`) agreed with *our*
  signed version — which turned out to be worthless as corroboration, because its own mechanics
  doc is the same KuromiAK document.
- **Settle it statistically from replay data.** Attempted, and it produced a wrong answer — see
  Consequences.
- **Wait for a second grade before flipping.** The three measured races share one course, so this
  is three samples at a single grade. Rejected as unnecessary: a 2% grade separates the candidates
  by 5x, the step is exact rather than statistical, and the adopted formula is independently the
  one two third-party implementations already use. A second grade would still be worth measuring
  to confirm the scaling directly.

## Consequences

- **Simulation output changes for every downhill on every course**, so the regression checkpoint
  in `test/regression/checkpoints/` was re-recorded. Per this repo's standing rule, the
  confinement check (a full `check.ts` run, reading `params.presupposedSkills` as well as
  `params.skillsUnderTest`) was run *before* re-recording, so the re-record is justified by a
  confirmed-confined diff rather than used to paper over one.
- **Downhill-heavy courses get relatively stronger**, and steep downhills disproportionately so.
  Any stored comparison or chart produced before this change is not comparable with one after it.
- **Inferring mechanics from observed speed in replay data is now known to be unreliable for
  target-speed effects.** SPD-7's corrected replay measurement — a paired within-horse-run
  comparison on a 1% grade, n=370, 95% CI [0.2055, 0.2413] — appeared to confirm the *signed*
  formula (0.2) and exclude the absolute one (0.4). It was wrong: it measured *observed* speed
  while the formula sets *target* speed, and a horse accelerates toward a raised target rather
  than jumping to it. Combined with ~1.07s frame quantisation smearing the edges of spans
  averaging ~5s, the attenuation pulled a true 0.4 down to 0.22. The tight confidence interval
  measured precision, not whether the right quantity was being measured. Treat replay-derived
  speed estimates as lower bounds on target-speed effects, and prefer `detailedSimulation`'s
  `targetSpeeds` where a race can be resimulated.
- **`detailedSimulation.annotations` is a much stronger validation substrate than anything
  previously available** — it also exposes `conservePower` (Fully Charged), `spotStruggle`,
  `dueling`, all five position-keep states, `lastSpurtDecision`, `positionKeepDecisions` and
  `skillActivationDecisions`. Tracked separately as a standing validation corpus rather than
  folded into this ticket.
