# ADR-0013: Unimplemented value/duration scaling codes fall through to identity (1.0), by table

**Status:** Accepted
**Date:** 2026-09-08 (SKL-7)

## Context

`ability_value_usage` and `ability_time_usage` are per-effect codes in `master_jp.mdb`'s
`skill_data` table that tell the game how to scale an effect's raw modifier/duration away from
"Direct" (code 1, no scaling) based on some piece of state — the uma's stats, the race scenario,
the field. 62 JP skills carry at least one non-Direct code on some effect (checked by querying
`master_jp.mdb`'s `skill_data` table directly for rows with a value/time usage column outside
`{0, 1}`, and cross-checked against the compiled `data/jp/skill_data.json`'s 2119 entries — both
agree exactly). Before this ticket, exactly one pair of codes had ever been implemented: value 8/9
("Multiply Random", HP-6) — a stochastic per-activation roll handled specially in
`RaceSolver.ts`'s `scaleEffectValue()`, not a function of context and so out of scope for a lookup
table. Every other code among those 62 skills passed its effect's modifier or duration through
completely unscaled, silently.

`plans/game-mechanics/skills.md`'s "Value Scaling"/"Duration Scaling" sections document what each
code is *supposed* to do. Not all of them are things this engine can actually compute:

- Value 2 (`MultiplySkillNum`), 13 (`MultiplyMaximumRawStatus`), 22/23 (`MultiplySpeed`), and
  duration 3/7 (`MultiplyRemainHp`) scale on the simulated horse's own stats or equipped-skill
  list — state `RaceSolver` already tracks.
- Value 3–7 (Aoharu team stats), 10 (Climax races won), 12 (Grand Live fan count), and 24 (L'Arc
  global potential) scale on training-scenario or account state a race simulator has no model of
  at all — there is no "team base stat total" or "fan count" anywhere in this engine.
- Value 19/20/21/25 and time 2/4/5/6 scale on field position, blocking duration, or lead
  distance — inputs `ActivationConditions.ts` already samples from a probability distribution
  rather than modeling geometrically (ADR-0002), so there is no ground-truth value to scale on.
- Value 14 needs per-activation counts of skills carrying tag 601–615 ("green skills"), data
  `skill_data.json` doesn't carry.
- Value 11, 26–40, and time 8 aren't documented anywhere in `game-mechanics/skills.md` — their
  formulas are simply unknown.

One earlier fix got the boundary between these groups wrong in a way this ticket had to undo:
before SKL-7, `tools/make_skill_data.pl`'s `patch_modifier()` included skill ids 210081/210082
(value usage 13) and 210261–210282 (value usage 2) in its scenario/account `×1.2` ceiling
approximation list. Both codes are actually horse-dependent (max raw stat, equipped-skill count),
not account state — baking a flat `1.2` into the shared, horse-independent `skill_data.json` for a
value that varies per horse is simply wrong, and once `RaceSolver` also started computing the real
factor for these two codes, applying both would have double-scaled the effect. SKL-7 removed
those eight ids from the generator's list (see `patch_modifier()`'s own comment) and does the real
computation at runtime instead.

## Decision

Implement only the codes genuinely computable from state this engine already models: value
2/13/22/23 and duration 3/7, in a new dependency-free module (`ValueScaling.ts` — no `RaceSolver`
import, no DOM, so `mackoz/uma-tools`'s Preact skill picker can import the exact same tables the
solver uses instead of re-deriving them, which is what let a stat-scaling factor drift out of sync
between engine and UI on HP-6). `RaceSolver` builds one `ScalingContext` per activation
(`skillCount`, `maxBaseStat`, `finalSpeed`, `remainingHp`) and routes both `valueScaleFactor()` and
`durationScaleFactor()` through it.

Every other code — the ~40 remaining of the 62 — returns exactly `1.0` from the same module, via
one table that states *why* for each group (scenario/account state; field/blocking/lead state
sampled statistically; missing skill-tag data; undocumented). The table lives in code, next to the
`switch` it documents, not only in a doc that can drift from what the `switch` actually does.

## Options considered

- **Throw on an unknown code**, matching this engine's existing fail-loud posture for unknown
  skill *conditions* (ADR-0004). Rejected: it would take down every one of the ~40 still-unmodeled
  skills at build time, for a much larger blast radius than ADR-0004's — a `ConditionParser` error
  means "we cannot simulate this skill at all" and is worth stopping the whole build over; an
  unmodeled scaling code means "we simulate this skill's magnitude slightly wrong," which is
  strictly better than refusing to simulate a shipped skill at all. The two situations only look
  alike on the surface. Note this is not a one-off exception carved out of ADR-0004's posture:
  ADR-0004's own 2026-08-21 amendment (`docs/adr/0004-fail-loud-unknown-conditions.md:27-29`)
  already records this engine reconsidering blanket fail-loud in favour of graceful degradation
  at the *smallest possible unit*, with the gap disclosed rather than crashed on. Identity
  fallthrough for an unmodeled scaling code is that same direction, applied one unit smaller
  still — one effect's magnitude, not one alternative or one skill — with `ValueScaling.ts`'s
  per-group reason table serving as the "explicit report of what was degraded" half.
- **Keep the approximation in the generator** (extend `patch_modifier()`'s `×1.2` list to cover
  every remaining code, the way it already does for the scenario/account ones). Rejected outright
  for value 2/13/22/23 and duration 3/7 specifically: those four are horse-dependent, and
  `skill_data.json` is one shared file read by every horse — a per-horse quantity cannot be baked
  into it as a constant. This is exactly the mistake described in Context above, and undoing it
  is part of what this ticket does.
- **Implement everything, approximating the un-computable groups with a best-guess formula**
  (e.g. assume a "typical" fan count or team stat total). Rejected: inventing an input the engine
  has no ground truth for produces a specific-looking wrong number, worse than the honest identity
  fallthrough — a `1.0x` is visibly "not modeled," a fabricated `1.07x` looks like real output.

### `NoopHpPolicy.hpRemaining()` returns `Infinity`

Duration scaling (`ability_time_usage` 3 and 7) reads `ScalingContext.remainingHp`, which the solver
fills from `this.hp.hpRemaining()`. `HpPolicy` has two implementations and only one of them models
HP: `RaceSolverBuilder.ts`'s generator hands out a real `GameHpPolicy` **only** when the builder was
put in `mode: 'compare'`, and `NoopHpPolicy` otherwise. `NoopHpPolicy` had no `hpRemaining()` before
this ticket, so one had to be chosen.

`Infinity` was chosen, over `0` or a "typical" finite stand-in, for consistency with the rest of that
object: `hasRemainingHp()` already returns `true` unconditionally and `hpRatioRemaining()` already
returns `1.0`. The policy's whole contract is "HP is not modeled here, so the uma is never
HP-limited," and `Infinity` is the only `hpRemaining()` that says the same thing. `0` would claim the
uma is HP-exhausted — the opposite of what the other two methods assert — and any finite stand-in
would be exactly the fabricated-input mistake rejected in the option above.

The consequence is worth stating plainly, because it is not obvious from the call site: **every
non-`compare` simulation path saturates duration scaling at its top bracket** (`4.0x` for time
usage 3, `3.0x` for 7). That includes `mackoz/uma-tools`'s Course Chart mode, which builds without
`mode: 'compare'`. Those paths already do not model stamina drain at all, so a skill's duration
there was never HP-conditioned in any other respect either; this is consistent with, not additional
to, the approximation those modes already make. Changing it — teaching non-`compare` paths a real HP
model, or picking a different sentinel — would alter output for every one of them, so it is
deliberately out of scope here and belongs in its own ticket rather than as a side effect of this
one. Any UI that renders a duration for a non-`compare` mode must feed `Infinity` too, or it will
advertise a duration the simulation never used.

## Consequences

- The four scenario/account groups (value 3–7, 10, 12, 24) keep their `×1.2` ceiling approximation
  in `tools/make_skill_data.pl`, unchanged by this ticket — defensible because `1.2` is genuinely
  the documented top tier for all four (Aoharu ≥3600 total, Climax ≥25 races, Grand Live's top fan
  bracket per hakuraku's cross-referenced table, L'Arc Lv≥20 — see `game-mechanics/skills.md`),
  so the approximation is a ceiling, not a guess. The coverage is not uniform, though: usage 12 is
  only *partially* covered. Three skills carry it — `210071`, `210072`, `210351` — and only the
  first two are listed in `patch_modifier()`'s `@scenario_skills`, so `210351` receives no
  approximation at all and its stored modifier is the plain unscaled base value. That asymmetry is
  inherited, not introduced here; whether to add `210351` to the list is deliberately left to its
  own ticket (SKL-32) rather than settled as a side effect of this one.
- Adding a newly-computable code later costs one `case` line in `ValueScaling.ts`'s
  `valueScaleFactor()`/`durationScaleFactor()`, plus — only if the code needs an input
  `ScalingContext` doesn't already carry — one new field threaded through from `RaceSolver.ts`.
  No other call site changes, since both callers (the solver and, eventually, the UI) already
  branch on the same table.
- `test/regression/checkpoints/`' recorded output for 19 skills (5 distinct test cases, 185 of
  8397 sampled assertions) is now legitimately stale, since those skills carry codes this ticket
  newly scales — SKL-7 re-recorded the checkpoint after confirming every failing case traced back
  to one of those 19 skills (never an unrelated one) and nothing else.
- The remaining ~40 skills' scaling is still wrong in the same direction it always was (unscaled,
  i.e. always `1.0x` regardless of true game state) — this ticket narrows the gap, it doesn't close
  it. Skill-level scaling (a separate, undocumented-in-code gap — levels 1–10, up to 1.25x) remains
  entirely unimplemented and is tracked separately as SKL-9.
