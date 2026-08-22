# ADR-0004: Unknown skill-condition tokens fail loudly, by name

**Status:** Accepted — under reconsideration
**Date:** 2026-08-20 (PR #2, "Fix SKL-6")

## Context

Skill data is generated from the live game's `master.mdb`, and the game keeps adding condition tokens. Before PR #2, a skill referencing a condition missing from `ActivationConditions.ts`'s `Conditions` table resolved to `undefined` inside the parser and crashed later with a bare `TypeError` — far from the cause, with no indication of *which* condition or skill was responsible. Several shipped, live skills hit this.

## Decision

`ConditionParser` throws a named error at skill-build time: `ParseError: unknown condition: <name>`. Four then-crashing conditions were implemented for real in the same change; the remaining unregistered names (3 Global + ~11 JP-only at the time) hit the loud error *deliberately* — the PR's own words: they fail "instead of silently crashing later with an unrelated `TypeError`", and the deferred names were judged "out of scope, mock-only work".

The posture this encodes: **a data gap should be impossible to miss.** A simulation that silently skipped an unknown condition could quietly mis-rank skills, and nobody would know to distrust it.

## Options considered

- **Silently skip the unparseable alternative or skill.** Rejected: silent wrongness is the worst failure mode for a tool whose entire output is comparative numbers.
- **Mock unknown conditions as always-true/always-false.** Rejected for the same reason, with extra bias.
- **Leave the bare `TypeError`.** Rejected: same crash, none of the diagnosability.

## Consequences

- Data gaps surface immediately, named, at build time — and the loud error has since driven real condition implementations rather than quiet rot.
- The cost: **one unknown token takes down the whole skill build**, not just the affected alternative. As the shipped data grows (and it grows with every game update), the blast radius grows with it.

## Amendments

**2026-08-21 — under reconsideration.** Sibling simulators in this ecosystem have independently converged on the opposite posture: degrade gracefully at the *smallest possible unit* (skip one activation alternative, or drop one unmodeled effect while keeping the rest of the skill), paired with an explicit machine-readable report of everything that was degraded, so the UI can disclose partial modeling instead of the build crashing. That design keeps this ADR's real goal — *a data gap should be impossible to miss* — while removing the blast-radius cost. A future change in that direction is under consideration; if taken, fail-fast should be retained for genuine syntax errors (malformed condition expressions), which indicate corrupt data rather than a modeling gap, and this record should be amended or superseded accordingly.
