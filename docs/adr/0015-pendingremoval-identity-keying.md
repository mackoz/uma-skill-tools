# ADR-0015: `pendingRemoval` keyed by `PendingSkill` identity, not bare `skillId`

**Status:** Accepted
**Date:** 2026-09-13 (HP-7, review round 5)

## Context

`RaceSolver.doActivateRandomGold()` force-activates a Gold/Evolution skill whose own effects
satisfy its candidate filter and carries an `ActivateRandomGold` (type 37) effect. Activating it
flags the entry for later removal from `pendingSkills` by adding to `this.pendingRemoval` — a
`Set` that, before this fix, was keyed by the plain string `s.skillId`, and consulted the same way:
`pendingSkillAction(s)` returned `PendingAction.Remove` whenever `this.pendingRemoval.has(s.skillId)`
was true for *any* pending entry sharing that id, not specifically the entry that had actually
fired.

That is wrong whenever more than one `PendingSkill` in `pendingSkills` shares the same `skillId`.
Two distinct, ordinary ways this happens:

- **A skill list that literally repeats an id.** The regression corpus's `presupposedSkills` field
  is a plain list of skill ids the solver is told to presuppose as already-equipped or otherwise
  in play; nothing in the builder de-duplicates it, and at least one recorded regression case
  carries `200953` twice in that list.
- **A multi-alternative skill.** A single `skillId` can carry several `alternatives` in the shipped
  data (different conditions/values selected by precondition), and depending on how a caller adds
  the skill, more than one alternative can end up as its own `PendingSkill` entry sharing the same
  `skillId`.

`RaceSolverBuilder.addOpponentDebuff` (`docs/adr/0014-victim-safe-debuff-conditions.md`) adds a
third, HP-7-specific route to the same collision, and it is the one that made this defect reachable
in ordinary product use rather than only in a hand-built regression case. `umalator/compare.ts`
adds both umas' equipped skills at `Perspective.Other` (`compare.ts:164-180`, `addSkill`) *before*
calling `addIncomingDebuffs` (which calls `addOpponentDebuff`), so configuring an incoming stamina
debuff for a skill id the opponent also equips ordinarily puts two `PendingSkill` entries sharing
that id into the same `pendingSkills` array: the opponent's plain equipped copy, and the
victim-safe configured copy. If `doActivateRandomGold()` then force-activates some unrelated,
non-`victimSafe` pending skill that happens to share that same `skillId` (the opponent's ordinary
copy, say), the bare-`skillId` keying flagged *that id* for removal — and `pendingSkillAction()`
had no way to tell which entry actually fired, so whichever entry sharing that id was reached
first by the removal-check loop got swept up as collateral. In the reachable case above, that
collateral entry is the configured, victim-safe debuff copy — silently discarded — while the
opponent's ordinary copy, the one that actually activated, never gets its own `Remove` flag cleared
and stays pending, free to activate again later. Net effect: one fewer configured debuff
activation, and one extra, uncounted activation of the ordinary copy.

Round 4 of this ticket already excluded `victimSafe` entries from `doActivateRandomGold()`'s own
candidate pool (`RaceSolver.ts`'s `goldIndices` predicate checks `!skill.victimSafe`) so a
configured debuff can never be the entry *force-activated*. That guard is necessary but not
sufficient: it stops a victim-safe entry from being *selected*, a separate concern from the
*removal* defect described here, which is about which entry gets swept up as collateral when some
*other*, non-victim-safe same-id entry is force-activated. The guard and this fix close two
different halves of the same failure mode.

## Decision

Key `pendingRemoval` by `PendingSkill` object identity (`Set<PendingSkill>`) instead of bare
`skillId` (`Set<string>`). `doActivateRandomGold()` now adds the exact `PendingSkill` instance it
force-activated (`this.pendingRemoval.add(s)`); `pendingSkillAction()` checks
`this.pendingRemoval.has(s)` against that same instance; the self-clearing delete in the
Activate/wisdom-fail-Remove branches likewise deletes `s` itself. Removal is now impossible to
misattribute to a different entry that merely shares a `skillId` — the only entry ever flagged or
matched is the one that actually fired.

The round-4 `!skill.victimSafe` guard in `goldIndices`'s candidate filter stays. It remains the
only thing that keeps a configured, victim-safe debuff entry from being *chosen* as the
force-activated skill in the first place — identity keying does nothing to prevent that selection,
it only fixes which entry gets removed once some (necessarily non-victim-safe) entry has already
been force-activated. Both guards are load-bearing; neither substitutes for the other.

## Evidence

Before re-recording the regression checkpoint, every one of the 39 cases whose activation pattern
moved under this change was individually traced back to the `pendingRemoval` keying change, per
the standard `test/regression/replay-case.ts` sets for attributing a moved case — not assumed from
the diff alone:

- **39 regression cases changed. All 39 changed their activation pattern** under the new keying
  versus the old.
- The old, bare-`skillId` keying produced **117 net extra activations** across those 39 cases.
- **30 of the 39** had at least one skill activate more times than it had pending entries for that
  id under the old keying; **0 of 39** show that pattern under identity keying.
- Inference: had ordinary cooldown re-arm explained the extra activations (a skill legitimately
  re-triggering after its cooldown timer elapsed), the same activation counts would appear under
  *both* keyings — re-arm behavior does not depend on how `pendingRemoval` is keyed. They appear
  under only the old keying. The old behavior was producing spurious extra activations, not
  correctly re-arming.

Checkpoint `20260911.17306b3` (956,108 assertions, 0 failures) is superseded by
`20260913.2a799f1` (commit `1786bcb`). The new corpus is a **fresh 10,000-case sample, not a
replay of the old one** — it reports **944,812 assertions, 0 failures**. The assertion-count drop
from 956,108 to 944,812 reflects that resampling, not lost coverage or a regression: a fresh
10,000-case draw does not produce the same case mix, activation counts, or therefore the same
total assertion count as the corpus it replaces, and every one of the 39 cases that did move was
independently attributed to this fix before the new corpus was recorded, per the paragraph above.

## Rejected alternative

A narrower fix was implemented and measured before this one was chosen:
`if (this.pendingRemoval.has(s.skillId) && !s.victimSafe)` — keep the bare-`skillId` `Set<string>`
keying exactly as it was, and add a `!s.victimSafe` condition to `pendingSkillAction()`'s removal
check so a victim-safe entry specifically can never be the one swept up as collateral.

This narrow variant genuinely fixes the HP-7 symptom (a configured incoming debuff no longer gets
silently discarded by an unrelated force-activation) and keeps the existing checkpoint valid
unchanged — 956,108 assertions, 0 failures, zero blast radius outside the debuff feature. It was
rejected in favor of identity keying because it only protects `victimSafe` entries: the exact same
wrong-instance-removal defect remains fully live for any two *ordinary* same-id pending entries
neither of which is `victimSafe` (the literal-duplicate-id and multi-alternative cases in Context
above) — those would continue to misattribute removal to whichever same-id entry the loop reaches
first, with no test or guard to catch it. HP-7 surfaced the underlying defect; the underlying
defect is not itself HP-7-shaped, and the narrow variant would have left it in place for every
other feature and skill that happens to hit it. Fixing the defect at its root — the keying itself
— was judged worth the wider (though, per the evidence above, fully attributed and expected) shift
in recorded regression output, over leaving a known wrong-instance-removal bug live behind a
patch scoped to one call site.

## Consequences

- This changes simulated race outcomes for any race containing a type-37 (`ActivateRandomGold`)
  carrier — `110071` ("Adventure of 564", data rarity 5 → `SkillRarity.Unique`) or `910071` (the same skill's rarity-1
  form, inheritable by any uma) — alongside a duplicate-`skillId` pending entry, whether that
  duplication comes from a repeated id in a presupposed/equipped skill list, a multi-alternative
  skill producing more than one pending entry for its id, or (the newly-reachable case)
  `umalator/compare.ts`'s opponent-equipped-copy-plus-configured-debuff-copy pattern. This corrects
  a **pre-existing** engine defect — the bare-`skillId` keying predates HP-7 entirely — that HP-7's
  `addOpponentDebuff` surfaced as an ordinary-use symptom rather than introduced.
- `pendingRemoval`'s type is now `Set<PendingSkill>` everywhere it is constructed, including in
  test stubs (`test/cooldown-distance-scaling.test.ts`, `test/cooldown-rearm.test.ts`,
  `test/gold-cooldown-exclusion.test.ts`) — a stub that still constructs `new Set<string>()` and
  adds a bare id string will silently never match any real `PendingSkill` instance.
- The regression checkpoint was re-recorded (see Evidence); any future bisection against the old
  `20260911.17306b3` checkpoint's recorded output for one of the 39 traced cases should expect a
  difference and treat it as this fix, not a new regression.
