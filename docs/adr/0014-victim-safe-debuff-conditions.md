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

**`.precondition` is not covered.** `buildSkillData()` parses `skill.precondition` directly
against the builder's own horse regardless of `victimSafe`, the same way `.condition` used to
before this rewrite — only `.condition` is routed through `victimSafeCondition()`. This is latent,
not fixed: no shipped debuff (JP or Global) carries a precondition
(`test/victim-safe-condition.test.ts`'s "no shipped debuff alternative carries a precondition"
test, HP-7 review round 3, pins this so it fails loudly the moment one ships), but a future debuff
that gained a caster-shaped precondition (order, running style, etc.) would be evaluated against
the victim unmodified, the exact denylist-style silent-under-fire failure mode this ADR's
"Allowlist over denylist" section argues against for `.condition`. Extending `victimSafeCondition`
coverage to `.precondition` is left to whenever a shipped skill actually needs it.

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

Peer-review fix (HP-7, review round 3): this section previously claimed that setting
`samplePolicy: RandomPolicy` on the `SkillData` `buildSkillData()` returns "avoids the collision
entirely" with `_samplePolicyOverride` (the map `addSkillAtPosition`'s forced-position policy is
stashed in, keyed by `getSamplePolicyKey(skillId, perspective)` — just `${skillId}:${perspective}`,
with no `victimSafe` component). That was wrong: `build()` and `prepPacerTriggers()` both read
`this._samplePolicyOverride.get(key) || sd.samplePolicy` — the override wins whenever a key is
present, regardless of what `sd.samplePolicy` holds. Since `addOpponentDebuff` and
`addSkillAtPosition` share that same key for the same skill id and perspective, a forced-position
input on one uma's builder (reachable through the always-visible "Force @ position" field, not an
advanced or hidden control) and a Stam Debuff dialog entry for the same skill id on the same
builder silently collide: the forced position wins and collapses every sampled activation of the
incoming debuff onto that one point. Both call sites now check `sd.victimSafe` before consulting
the override map at all, so a victim-safe debuff's forced `RandomPolicy` can never be overridden.

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

### Target-type 18 (`EnemyStrategy`) running-style gate: enforced via the condition term, not `isTarget()`

Some debuffs additionally restrict by the *victim's* running style via `SkillTarget` type 18
(`EnemyStrategy` — "only opponents of running style X"), which is a property of the effect's
target filter. `buildSkillEffects()`'s `isTarget()` check does not look at it — it only ever
compares `SkillTarget.Self`/`SkillTarget.All` against `Perspective`, and has not been extended to
read type 18 or the solved horse's own strategy at all.

Peer-review fix (HP-7, review round 2): this section previously said a target-18 debuff "will
still apply … regardless of the solved horse's own running style" through `addOpponentDebuff`.
That was true when written, but the sibling peer-review fix restoring
`running_style_count_{nige,senko,sashi,oikomi}_otherself` to `VictimSafeConditions` (see "Decision"
above) made it false: **every shipped `target: 18` effect also carries one of these four terms in
its condition** — verified directly against both datasets, identically: all 12 shipped effects
using `SkillTarget.EnemyStrategy` (`200831`/`200841`/`200851` gated on `_nige_`,
`200861`/`200871`/`200881` on `_senko_`, `200891`/`200901`/`200911` on `_sashi_`, and
`200921`/`200931`/`200941` on `_oikomi_`) each pair `target: 18` with exactly one
`running_style_count_*_otherself>=1` clause — the stamina-debuff family this ADR is centrally about
(`200831`/`200841`/`200861`/`200871`/`200891`/`200901`/`200921`/`200931`, effect type 9) plus a
sibling non-stamina family at the same 12-skill target-18 surface (`200851`/`200881`/`200911`/
`200941`, effect type 21) that isn't itself in scope here but shares the same condition shape.
Since that clause is now kept (not stripped) and evaluates `strategyMatches(victim.strategy, Strategy.X)` against the
victim — precisely the `EnemyStrategy` restriction the target type names — the gate **is** enforced
today, for every shipped skill, just via the condition term rather than via `isTarget()`.

`isTarget()` remaining unextended for type 18 is still a real, latent gap — a *hypothetical* future
debuff that used `SkillTarget.EnemyStrategy` without also carrying a matching
`running_style_count_*_otherself` condition term would apply unconditionally by running style,
same as this section originally described. No shipped skill relies on that combination today; a
caller that needs `isTarget()` itself to enforce the gate (independent of what condition terms a
skill happens to carry) still needs `buildSkillEffects()` extended with the solved horse's own
strategy, left to a future ticket as before.

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

- `addOpponentDebuff`'s configured count is exact per the test suite's tolerance (`toBeCloseTo` with
  4 decimal places) across seeds, **provided the victim-safe entry stays excluded from
  `doActivateRandomGold()`'s forced-gold-activation pool** (`RaceSolver.ts`'s `goldIndices`
  predicate checks `!skill.victimSafe`) — no wisdom-roll attrition, no caster-state clause silently
  vetoing an otherwise-landed hit, and no gold-activation skill on the victim (e.g. an inherited
  Adventure of 564) force-firing a pending debuff outside its real window. A round-7 review found
  this guarantee did not yet hold: `doActivateRandomGold()` filtered on rarity and effect type only,
  so a gold-or-Evolution incoming debuff (14 of the 30 shipped skills qualify) could be
  force-activated by an unrelated `SkillType.ActivateRandomGold` effect on the victim, firing
  outside its window and — because `pendingRemoval` is a `Set` keyed by bare `skillId` — only
  removing one of N same-id configured copies, so a surviving copy fired again (N+1 drains). Fixed
  by excluding victim-safe entries from that pool; see `test/opponent-debuff.test.ts`'s regression
  test for the repro.
- `VictimSafeConditions` must be extended whenever a new debuff-relevant condition term is
  identified as course/timing-shaped rather than caster-shaped; missing one *now* fails loudly via
  `test/victim-safe-condition.test.ts`'s unclassified-term check rather than quietly.
- Target-type 18's running-style gate is enforced today for every shipped skill, via the
  `running_style_count_*_otherself` condition term every one of them happens to also carry — not
  via `isTarget()`, which remains unextended for `SkillTarget.EnemyStrategy` specifically. A
  hypothetical future skill using target-18 *without* that condition term would get the debuff
  applied unconditionally by running style; a future ticket extending `isTarget()` itself would
  close that gap independent of what condition terms a skill happens to carry.
- `VictimSafeConditions` carries a load-bearing assumption of its own for these four terms
  specifically: each is implemented in `ActivationConditions.ts` as a bare `valueFilter` that reads
  only the operator's *truthiness* of the comparison, not its magnitude, and is only ever shipped
  as `>=1` (`ActivationConditions.ts`'s own comment above the entries notes this: "abusing
  `valueFilter` like this only works because these conditions are used like
  `running_style_count_nige_otherself>=1`"). A future data refresh shipping `>=2` on one of these
  terms would keep the clause on the allowlist (still classified, so the tripwire this ADR's
  "Allowlist over denylist" section describes stays green) but silently never fire — `1 >= 2` is
  false for every victim, which is exactly the invisible under-firing that section argues an
  allowlist protects against for every *other* term. `test/victim-safe-condition.test.ts` asserts
  these four terms appear only as `>=1` across the shipped data specifically to catch this before
  it ships, since the general unclassified-term tripwire alone would not.
