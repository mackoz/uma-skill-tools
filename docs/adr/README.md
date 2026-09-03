# Architecture Decision Records

This directory records the *why* behind this engine's significant decisions — the things a future reader (including a future maintainer with no memory of the context) would otherwise have to reverse-engineer from diffs, or worse, silently "fix". Reference documentation (what the code does now) lives in `README.md`; these records hold what was decided, what else was considered, and what it costs.

## When to write one

Write an ADR when a change settles a question that could reasonably have gone another way: a modeling approximation, a numeric-output-affecting design, a deliberate deviation from alpha123 or from the game, a failure-handling posture. Small fixes and refactors don't need one. If a change *reverses* a recorded decision, don't rewrite history — add a dated **Amendment** to the old record (or mark it Superseded and write a new one).

## Format

Each record: **Status** · **Date** · **Context** (the problem and its constraints) · **Decision** (one decision per record) · **Options considered** (including rejected ones and why they lost) · **Consequences** (costs included, honestly) · **Amendments** (dated, appended, never silently edited).

Statuses:
- **Accepted** — current, deliberate.
- **Accepted — under reconsideration** — still current behavior, but evidence has accumulated against it; an amendment says what and why.
- **Inherited (rationale reconstructed)** — the decision predates this fork (alpha123 or the kachi-lineage import); the record reconstructs the likely rationale from code, comments, and history rather than first-hand knowledge. Treat the reconstruction as honest inference, not testimony.
- **Superseded** — replaced; the record stays, pointing at its replacement.

Numbers are never reused or renumbered, even if a record is retired — gaps are meaningful and retired records keep a tombstone entry here.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-single-uma-plus-pacer-scope.md) | Simulate a configured handful of umas, not a full live-read field | Inherited (rationale reconstructed) |
| [0002](0002-markov-chain-field-conditions.md) | Field-dependent skill conditions are probability stand-ins, not geometry | Inherited (rationale reconstructed) |
| [0003](0003-prando-rng-shim.md) | `Rule30CARng` is a prando-backed shim, not a Rule-30 generator | Inherited (rationale reconstructed) |
| [0004](0004-fail-loud-unknown-conditions.md) | Unknown skill-condition tokens fail loudly, by name | Accepted — under reconsideration |
| [0005](0005-per-skill-rng-streams.md) | Per-skill derived RNG streams (`deriveSeed`) | Accepted |
| [0006](0006-exact-quantile-normalization.md) | Exact analytic quantile normalization for trigger sampling | Accepted |
| [0007](0007-pacer-triggers-once-per-slot.md) | Pacer skill triggers sampled once per slot, not per scenario | Accepted |
| [0008](0008-spot-struggle-geometry-field-derived-state.md) | Spot Struggle's trigger/exit geometry derives state from the field, adds no race object | Accepted |
| [0009](0009-replay-validation-manual-capability.md) | Replay validation is a manual capability, not a committed regression test | Accepted |
| [0010](0010-activate-counts-as-random-is-activate-any-skill.md) | `conditionsWithActivateCountsAsRandom` now shadows `is_activate_any_skill` | Accepted |
