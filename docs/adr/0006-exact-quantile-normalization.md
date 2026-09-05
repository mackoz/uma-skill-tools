# ADR-0006: Exact analytic quantile normalization for trigger sampling

**Status:** Accepted
**Date:** 2026-08-20 (`bd95b39`, "stabilize statistical sampling")

## Context

Distribution-modeled trigger conditions (ADR-0002's second tier) draw a value from an Erlang or log-normal distribution and must map it onto the condition's course region. That mapping needs bounds. Deriving the bounds from the *observed* min/max of the drawn batch makes the mapping depend on the sample count and on the batch's luck: the same skill lands in different places at n=25 than at n=1600, and re-running shifts everything. For a chart whose whole method is comparing across sample sizes, that instability was directly visible.

## Decision

Normalize against **fixed analytic quantiles of the distribution itself** — the 0.1% and 99.9% quantiles (`CENTRAL_LOWER_QUANTILE`/`CENTRAL_UPPER_QUANTILE`, `ActivationSamplePolicy.ts:100-101`) — computed exactly:

- **Erlang:** the exact CDF, inverted by bisection (80 iterations with an initial doubling bracket, `erlangQuantile`), memoized per `(k, λ)` in a module-level cache so the cost is paid once per distribution shape, not per draw.
- **Normal (for the log-normal path):** Acklam's inverse-normal approximation, with the code's own justification in place: "Accuracy is ample for fixed 0.1%/99.9% bounds."
- Values are then mapped through `clampToCourseRange`, which clamps the normalized position into `[0, courseRange · (1 − ε))` — the ε keeping a maximal draw strictly inside the region rather than exactly on its end.

## Options considered

- **Observed min/max of the batch** (the inherited behavior): rejected — sample-count-dependent, run-to-run unstable, and biased (extremes grow with n).
- **Closed-form approximations to the Erlang quantile** (e.g. Wilson–Hilferty, as used elsewhere in this engine's family tree): rejected — the approximation error (percent-level on the bounds, worst at small k, including a negative lower bound at k=1) systematically shifts trigger positions on long regions, and exact bisection is cheap once memoized.
- **Exact quantiles at more central cut points** (1%/99%): would discard real tail mass; 0.1%/99.9% keeps effectively the whole distribution while still being finite.

## Consequences

- Trigger placement is now a pure function of the distribution and the scenario seed — independent of sample count and batch. Ladder steps at different n are comparable, which the statistical chart requires.
- Numeric output changed relative to observed-extremes normalization (part of `bd95b39`'s output change, together with ADR-0005).
- The behavior is test-covered (`test/activation-sampling.test.ts`, added in the same commit as `test/activation-sampling.ts` and migrated to Vitest by PIPE-50) — the first mechanics-adjacent unit tests in this fork; keep them green when touching sample policies.
- The ε-clamp doubles as an invariant: downstream region arithmetic may assume a sampled position is strictly less than the region end.
