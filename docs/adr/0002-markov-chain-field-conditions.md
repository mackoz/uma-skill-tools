# ADR-0002: Field-dependent skill conditions are probability stand-ins, not geometry

**Status:** Inherited (rationale reconstructed)
**Date recorded:** 2026-08-21 (mechanism inherited via the kachi-lineage import, `9c0652a`; the distribution-modeled conditions predate that in upstream)

## Context

Follows from ADR-0001: the simulated group is a compared pair plus pacemakers, not a representative field, so conditions like `blocked_side_continuetime`, `overtake`, `near_count`, `is_surrounded`, and the vision checks have nothing *representative* to measure — `README.md` puts it directly: "Many multi-uma-dependent conditions still can't be simulated literally even with a full field … those are modeled by runtime Markov-chain approximations … rather than static pre-race probability distributions." But skills that use them still need *some* activation behavior, or whole skill families would be unsimulatable.

## Decision

Field-dependent conditions are answered by probability models instead of geometry, in two tiers:

1. **Phase-keyed start/continue chains** (`SpecialConditions.ts` + `ApproximateConditions.ts`): each simulated frame, a blocked/overtake state starts with probability *p_start* and persists with probability *p_continue*, with the pair chosen by race phase or strategy — e.g. blocked-side uses 0.1/0.85 in the early race, 0.08/0.75 mid-race, 0.07/0.50 otherwise, and 0.0/0.0 when running an outer lane in sections 1–3; overtake uses 0.05/0.50 for 逃げ, 0.15/0.55 for 先行, 0.20/0.60 for everything else.
2. **Distribution-modeled triggers** (`ActivationSamplePolicy.ts`): conditions whose *position* along the course is what varies (rather than a per-frame state) get their trigger placed by a fitted probability distribution (Erlang or log-normal), sampled once per scenario.

## Options considered

- **Real geometry** — requires ADR-0001 to go the other way; not available in this scope.
- **Always-true / always-false stubs** — strictly worse: they make conditional skills either free or worthless, which biases exactly the comparisons this engine exists to make. A probability model at least spreads activations plausibly.
- **Dynamic modeling via a Poisson process** — upstream's own aspiration, recorded in `ActivationSamplePolicy.ts` (comment by the upstream author, 2023): reconciling two distribution-modeled conditions "should be the joint probability distribution … but that is too complex to implement", and "eventually we'd like to model most of the conditions that use DistributionRandomPolicy with dynamic conditions using a Poisson process or something, which would make this obsolete (this would also enable other features like cooldowns for distribution-random skills)." Never built, here or upstream.

## Consequences

- Skills gated on these conditions *do* activate, with plausible-looking frequency, so they can be ranked at all.
- The constants have **no documented source** — they appear in no public game-mechanics reference we know of, and no derivation survives in the history. Every conclusion about a blocking-conditional skill rests on them. They should be treated as tuning parameters, not facts.
- Because the stand-ins are per-uma random draws, two umas in a comparison never "block each other" — the states are uncorrelated with anything physical, including each other.
- When two distribution-modeled conditions combine, one simply wins (the code's own comment concedes this is "strictly speaking, probably not the right thing to do") — the joint distribution is not modeled.
