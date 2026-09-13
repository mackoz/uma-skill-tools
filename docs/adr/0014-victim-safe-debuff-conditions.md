# ADR-0014: Victim-safe condition rewriting for incoming opponent debuffs

**Status:** Accepted
**Date:** 2026-09-12 (HP-7)

## Context

`RaceSolverBuilder.addOpponentDebuff(skillId)` (HP-7) lets a caller simulate a stamina debuff that
an *opponent* lands on the horse being solved, without simulating that opponent at all — no second
`RaceSolver`, no roster. But every debuff's condition string was authored to be evaluated against
its *caster*: `buildSkillData()` always calls `parser.parse(parser.tokenize(skill.condition))`
against the builder's own horse and race params (`extra`), so an unmodified debuff condition would
be checked against the *victim* instead. Some clauses this reaches describe the caster's own state
— running style (`running_style==*`), order/position, whether *they* are blocked or dueling — and
those clauses can be false for the victim even on a horse the skill would genuinely have hit in a
real race. All-Seeing Eyes (skill 201441), for instance, requires the caster to be a Late Surger;
naively evaluated against a Pace Chaser victim, the debuff would never fire, even though the whole
point of `addOpponentDebuff` is "this landed regardless of who's simulated" (checked against
`RaceSolverBuilder.ts`'s `buildSkillData()` and `test/opponent-debuff.test.ts`'s "caster terms
would exclude the victim" case, which pins exactly this).

## Decision

`victimSafeCondition()` (`RaceSolverBuilder.ts`) rewrites a debuff's condition string before it
reaches the parser, keeping only clauses built from an **allowlist** of terms
(`VictimSafeConditions`, ANCHOR `victim-safe-condition-allowlist`): `phase`, `phase_random`,
`accumulatetime`, `distance_type`, and `running_style_count_{nige,senko,sashi,oikomi}_otherself`.
`distance_type` is course-shaped, not caster-shaped — it says which distance category the *course
itself* is, true or false identically for every horse on that course, so it carries no
caster-vs-victim distinction to get wrong. The four `running_style_count_*_otherself` terms look
caster-shaped (the "_otherself" suffix) but are not: `ActivationConditions.ts` implements each as a
`valueFilter` reading `horse.strategy` off the builder's own horse, which under this rewrite *is*
the victim, so unmodified they already ask "is the victim a Front Runner/Pace Chaser/Late
Surger/End Closer" — exactly the running-style gate the Subdued/Flustered debuff family (`200831`
et al.) is meant to apply to its victim. Everything else describes the caster (order, running
style via the plain `running_style` term, blocking, dueling, temptation state, and so on) and is
stripped. Filtering happens per `&`-clause within each `@`-branch; a branch that loses every clause
is unconditional, and a condition where *every* branch reduces that way returns `''` for the caller
to treat as "no condition" (parser has no other representation for it).

`victimSafe` (`buildSkillData()`'s parameter, threaded onto `SkillData`/`PendingSkill`) gates this
rewrite so it only applies to skills added via `addOpponentDebuff` — a horse's own skills are
evaluated against their true caster (itself) and need no rewriting.

### Allowlist over denylist

The two failure modes an unclassified term can produce are not symmetric, and that asymmetry is
why this is an allowlist rather than a denylist of caster terms to strip:

- **A denylist miss** (a caster term nobody added to the denylist) evaluates against the victim
  unmodified. If that clause happens to be false for the victim's actual state, the debuff simply
  never fires for a landed hit — wrong, but invisible: nothing errors, nothing looks unusual, the
  configured debuff count just quietly reads low over enough seeds.
- **Over-stripping** (a genuinely victim-safe term the allowlist doesn't yet include) widens the
  firing window — the debuff fires in cases the real game's caster-side gate would have excluded.
  Wrong, but *observable*: the debuff fires more often, and `test/victim-safe-condition.test.ts`
  fails outright on any condition term it doesn't recognize, one way or the other, so an
  unclassified term can't ship silently either way.

A denylist's failure mode is strictly worse: it degrades in the direction that looks like nothing
happened. An allowlist's failure mode degrades in the direction that's easiest to notice and
easiest to reason about (a debuff firing more than the real skill's own gate would allow, rather
than silently under-firing). Given a future data refresh will keep introducing condition terms
this code has never seen, the allowlist is the posture that fails safe.

### Forced `RandomPolicy`

`buildSkillData()` also overrides the resulting trigger's sample policy to `RandomPolicy` whenever
`victimSafe` is set, regardless of what the (possibly rewritten) condition would otherwise imply.
A bare `phase>=N` condition carries `ImmediatePolicy` — every sample pins to the exact start of its
region. That's correct for a horse whose own condition genuinely resolves that way, but a debuff
landing on the *victim* from an unmodeled opponent has no such precision: it lands at some
arbitrary point in its real trigger window, not deterministically at the window's boundary. Forcing
a uniform draw over the (possibly widened, post-strip) window models "landed sometime in this
window" instead of "landed at the first possible instant of this window every single sample" —
the latter would understate the real HP loss whenever the drain has time-dependent duration
effects layered on top of a fixed pin point.

### Wisdom bypass (`victimSafe` on `PendingSkill`)

`checkWisdomForSkill()` rolls `max(100 - 9000/wisdom, 20)%` against `originWisdom` to decide whether
the *caster* actually chooses to use a skill it's otherwise eligible for. For an incoming debuff
there is no caster to model — `addOpponentDebuff` takes a configured count of instances that
already means "this many landed," not "this many were attempted." Running the wisdom roll on top of
that count would double-count the same uncertainty the count already represents, silently reducing
the configured number below what was asked for. `shouldSkipWisdomCheck()` short-circuits to `true`
for any `PendingSkill` with `victimSafe` set, immediately after its existing
`!this.skillWisdomCheck` guard, so an incoming debuff always resolves to `PendingAction.Activate`
once its (rewritten) trigger and dynamic condition are satisfied — pinned by
`test/opponent-debuff.test.ts`'s wisdom test, run across 25 seeds.

### Target-type 18 (`EnemyStrategy`) running-style gate: knowingly not modelled

Some debuffs additionally restrict by the *victim's* running style via `SkillTarget` type 18
(`EnemyStrategy` — "only opponents of running style X"), which is a property of the effect's
target filter, not of the condition string `victimSafeCondition()` rewrites. `addOpponentDebuff`
does not check this: a debuff gated to only affect, say, Nige opponents will still apply through
`addOpponentDebuff` regardless of the solved horse's own running style. This is a known, deliberate
gap rather than an oversight — modeling it correctly needs `buildSkillEffects()`'s `isTarget()`
check (which already handles `SkillTarget.Self`/`SkillTarget.All` for perspective) extended with
the solved horse's own strategy, and HP-7 didn't need it for its own scope. A caller configuring a
target-type-18 debuff via `addOpponentDebuff` today gets it applied unconditionally by running
style; narrowing that is left to a future ticket.

## Rejected alternatives

- **Simulate a real opponent caster instead of rewriting the condition.** Would resolve every
  caster-state clause correctly, including the running-style gate above, but requires standing up a
  second `RaceSolver` (or more) per debuff, with its own stats, running style, and position — far
  outside `addOpponentDebuff`'s scope of "apply this debuff's effect to my own horse's HP," and the
  same class of cost `docs/adr/0001-single-uma-plus-pacer-scope.md` already declined to pay for the
  engine generally.
- **Denylist known caster terms instead of allowlisting known victim-safe ones.** Rejected for the
  asymmetry argued above — a denylist's blind spot silently under-fires, an allowlist's silently
  over-fires-and-is-caught-by-test. Given the game keeps adding condition terms over time (the same
  open-set concern `docs/adr/0013-value-scaling-identity-fallthrough.md` raises for scaling codes),
  the allowlist's fail-safe direction was judged worth the up-front cost of enumerating a handful
  of terms instead of an unbounded caster vocabulary.
- **Leave the caster's original sample policy in place instead of forcing `RandomPolicy`.** Rejected
  because it silently mispredicts timing precision for exactly the conditions this rewrite is
  designed to widen (`phase`/`phase_random`) — `ImmediatePolicy`'s single boundary-pinned sample is
  a property of the *caster's* deterministic decision to fire the moment it's eligible, which an
  anonymous victim-side landing has no equivalent of.
- **Apply the wisdom roll anyway, using the victim's own wisdom stat as a stand-in for the missing
  caster's.** Rejected: it isn't a stand-in for anything real — the roll models a specific caster's
  specific wisdom deciding whether *that horse* uses the skill, and substituting the victim's
  wisdom answers a question ("would I choose to use this on myself") that has no bearing on whether
  an opponent's debuff, already configured as "N landed," actually landed.

## Consequences

- `addOpponentDebuff`'s configured count is now exact per the test suite's tolerance (`toBeCloseTo`
  with 4 decimal places) across seeds — no wisdom-roll attrition, no caster-state clause silently
  vetoing an otherwise-landed hit.
- `VictimSafeConditions` must be extended whenever a new debuff-relevant condition term is
  identified as course/timing-shaped rather than caster-shaped; missing one *now* fails loudly via
  `test/victim-safe-condition.test.ts`'s unclassified-term check rather than quietly.
- Target-type 18's running-style gate remains unmodelled — a caller relying on `addOpponentDebuff`
  to respect it will get the debuff unconditionally, regardless of the solved horse's own strategy,
  until a future ticket extends `isTarget()` to check it.
