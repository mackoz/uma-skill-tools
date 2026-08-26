# ADR-0008: Spot Struggle's trigger/exit geometry derives state from the field, adds no race object

**Status:** Accepted
**Date:** 2026-08-25 (`2cd27eb`, DYN-14)

## Context

DYN-14 rewrote `updateLeadCompetition()`'s trigger/exit geometry to match the game's `CompeteTop`
rules (source: [hakuraku.moe/notes/spot-struggle](https://hakuraku.moe/notes/spot-struggle), a
replay-frame analysis quoting the game's own parameter block). Doing that correctly required
several judgment calls this engine's existing architecture doesn't have obvious defaults for —
there is no race-level object, only `RaceSolver` instances that reference each other through
`this.umas`. This record exists because a 2026-08-26 `/paired-review` pass flagged the absence of
one ("Significant design decisions get an ADR... when a change settles a question that could have
gone another way, add or amend one" — `CLAUDE.md` rule 5) and the reviewer judged the design
rationale wasn't theirs to reconstruct unilaterally. It is.

## Decision

Four related choices, all following the same principle — **derive whatever the game's per-race
state needs from the umas that already exist in `this.umas`, rather than adding a new field or a
race-level coordinator object**:

1. **Once-per-race-per-style trigger gate** (`CompeteTop`'s `NigeCount`/`OonigeCount: 1`) is
   computed by scanning same-style umas in `this.umas` for an existing non-null
   `leadCompetitionStart`, not by a dedicated `spotStruggleTriggered: Set<Strategy>`-style field.
2. **Frontmost-uma reference** for the entry distance/lane check is computed fresh each call via
   `RaceSolver.frontmostByPos()`, not cached or determined by a separate "who is leading"
   coordinator pass.
3. **The distance/lateral-exit cascade rule** (an uma exits once every *other* active participant
   has left, but only if they left via distance/lateral, not natural duration expiry) is tracked
   with one new boolean field, `leadCompetitionDistanceExited`, read the same way — scanned across
   `this.umas` — rather than a race-level list of "who's still struggling and how they left."
4. **Lateral checks (`LaneGap1`/`LaneGap2`) are skipped entirely when `laneMovementEnabled` is
   false** (e.g. the Skill Chart, which hard-codes `laneMovement: false` while still allowing
   `leadCompetition: true` in "Full race" mode — `umalator/app.tsx`'s `buildChartOptions`), rather
   than evaluating the lateral check against the frozen starting-gate lane positions that persist
   when lane movement is off.

## Options considered

- **A race-level coordinator object** (matching torena-sim's `Race` aggregate, which owns
  `spot_struggle_triggered: Vec<Strategy>` and runs group-trigger/exit as per-tick coordinator
  passes over a frozen field snapshot — see `plans/fork-comparison/torena-sim/architecture.md`).
  Rejected: this engine has no race object at all — every `RaceSolver` is its own instance,
  triggering group state by writing directly onto sibling instances via `this.umas`. Introducing
  one just for Spot Struggle would be a new architectural layer for a single mechanic, and every
  other multi-uma mechanic in this file (`updatefirstUmaInLateRace()`, `getPacer()`) already uses
  the same "any uma's tick can read/write the whole field via `this.umas`" pattern. Field-derived
  state matches the codebase's existing shape; a coordinator object would be the odd one out.
- **A dedicated per-race trigger-tracking field**, threaded through the builder like
  `leadCompetitionEnabled`. Rejected for the same reason: there's no race-level object to own it,
  and every `RaceSolver` in `this.umas` already carries `leadCompetitionStart` — scanning that is
  strictly less new surface than adding and threading a second field through
  `RaceSolverBuilder.ts` for information the existing field already encodes.
  Note the exit side did need one new field (`leadCompetitionDistanceExited`) — the cascade rule
  genuinely can't be derived from `leadCompetition`/`leadCompetitionStart` alone, since both
  natural-expiry and distance-exit set `leadCompetition = false` and leave `leadCompetitionStart`
  non-null. This was the one place a new field was unavoidable, not a case where the "derive it"
  principle above was simply not applied.
- **Evaluate the lateral checks against frozen gate-lane positions even with lane movement off.**
  Rejected: those positions are an artifact of the starting-gate draw (`gateNumber * horseLane`,
  spread ~0–5m across 9 gates), not a simulated fact about where umas are relative to each other
  mid-race. Comparing against them would make roughly half of Skill Chart "Full race" runs
  silently suppress or allow Spot Struggle purely on which gate a horse drew, with no
  corresponding effect in the actual game — worse than skipping the check, which just narrows
  Spot Struggle to its distance-only conditions in that mode (the same trade-off this engine
  already accepts everywhere lane movement is off).

## Consequences

- No new race-level abstraction was introduced; the mechanic fits the existing "instances mutate
  each other through `this.umas`" shape used elsewhere in `RaceSolver.ts`. The cost is that every
  read of "has this style already triggered" or "who else is still active" is an `O(n)` scan of
  `this.umas` rather than an `O(1)` field read — negligible at this engine's scale (a handful of
  real umas plus optional pacers), but would need revisiting if this engine ever grows a real
  multi-uma field simulation (the structural gap already tracked against torena-sim's "Contested"
  mode).
- `leadCompetitionDistanceExited` is the one net-new field this decision produced. It's never
  reset (each `RaceSolver` is constructed fresh per scenario, and each style struggles at most
  once per race, so it only ever needs to mean one thing) — a corollary of decision 3, recorded
  here so a future reader doesn't wonder why there's no reset path.
- Decision 4 means Compare mode (lane movement on) and the Skill Chart (lane movement off) can
  now report genuinely different Spot Struggle statistics for the same horses on the same course
  — not a bug, but worth knowing when a chart run and a Compare run disagree on trigger frequency.
- A related, *not yet resolved* ordering question surfaced independently during the same
  `/paired-review` pass and is tracked separately, not folded into this record: `this.umas`'s
  entries can have asymmetric position freshness within a single Compare-mode frame, since
  `umalator/compare.ts` steps umas sequentially and `RaceSolver.step()` updates `this.pos` only
  after `updateLeadCompetition()` reads the field — see work-queue DYN-17.
