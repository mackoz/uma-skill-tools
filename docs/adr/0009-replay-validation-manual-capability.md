# ADR-0009: Replay validation is a manual capability, not a committed regression test

**Status:** Accepted
**Date:** 2026-08-30 (PIPE-21, PIPE-36, PIPE-37)

## Context

PIPE-21 built the first real-data check this engine has ever had: `tools/replay/parseReplay.ts`
decodes hakuraku-format saved-race JSON, `tools/replay/replayDiff.ts` diffs the simulator's
physics against a decoded replay, and (PIPE-37) `tools/replay/corpusReport.ts` +
`tools/replay/analyze_replay_diff.py` turn a whole corpus of replays into a citable accuracy
report. This is real, valuable capability — the first time "how accurate is the simulator"
has had a measured answer rather than a guess.

The corpus that capability runs against (`uma-tools-plans/replay-corpus/`) is private-repo-only:
each replay carries other players' trainer names, nicknames, and full builds (see that
directory's own README). `uma-skill-tools` is public. This is a real, structural mismatch —
not a matter of convenience — between where the validation tooling lives and where the data
it validates against can legally/ethically live.

The question this record settles: does that mismatch mean the corpus should be committed
somewhere accessible to this repo's own CI, or does replay validation stay a manual,
externally-triggered capability forever?

## Decision

**Replay validation stays a manual capability run from a local checkout with the private
corpus present, never a committed regression test in this repo's own test suite (`npm test`)
or CI.**

Concretely:
- `tools/replay/*.ts` and `tools/replay/*.py` are checked into this public repo — the
  *tooling* is a first-class, maintained capability.
- The corpus itself never is, and never will be, referenceable from a committed test fixture
  in this repo. A golden-checkpoint test (the pattern `test/regression/` already uses for
  the engine's own known-good outputs) structurally cannot exist for replay validation,
  because it would require either committing private data here or fetching it from the
  private repo at CI time — both closed off by the corpus's own privacy constraint.
- Verification of `tools/replay/` itself (does `parseReplay.ts` still decode cleanly, does
  `replayDiff.ts`'s regression baseline still reproduce byte-for-byte, does
  `corpusReport.ts`'s privacy gate still redact correctly) is done by hand, by whoever is
  working a replay-validation ticket, against their own local copy of the corpus — documented
  per-ticket in that ticket's `## Outcome`, not encoded as an automated gate.
- Accuracy *numbers* produced by this tooling (e.g. PIPE-37's headline バ身 error figures) are
  published in that ticket's `## Outcome` and in a generated report/artifact — never in this
  ADR, and never as a hard-coded expected value anywhere in this repo's own test suite.

## Options considered

- **Commit a small, anonymized sample of the corpus to this repo**, enough for a real
  automated regression test. Rejected: even a single real replay carries a real trainer's
  real build and (depending on lobby composition) potentially identifiable information about
  other real players who did not consent to their race data being published in a public
  software repository. "Anonymize it" is not a small task done once — every field PIPE-37's
  own privacy work had to reason about (`responseHorseData`, and the initially-missed
  `trainedCharaData`) would need to be stripped from a committed fixture too, and a stripped
  fixture stops being useful for testing exactly the parsing/decoding logic that reads those
  fields. Not worth the risk for a convenience gain.
- **Fetch the private corpus at CI time from `uma-tools-plans`.** Rejected: `uma-tools`'s CI
  (`deploy.yml`) has no credentials scoped to a second, private repository, and provisioning
  some would turn a measurement-tooling ticket into a cross-repo CI-security project. Also
  doesn't solve the underlying problem — the data would still need to *exist* somewhere a
  public CI runner can read it, which is the actual constraint, not just a fetching mechanic.
- **Synthetic/generated replay data**, so tests never need real player data at all. Rejected
  for this specific capability (though not rejected in general — `test/regression/`'s
  checkpoints already do exactly this for the engine's own physics): the entire *point* of
  `tools/replay/` is comparing this engine's output against something it did not generate —
  real players' real races, recorded by the real game server. A synthetic "replay" generated
  by this engine itself would only ever be able to confirm the engine agrees with itself,
  which every other test in this repo already does more directly. It would validate nothing
  new.
- **Don't build this capability at all**, and rely on doc-vs-doc comparison against reference
  implementations (as most of `work-queue/backlog/engine/`'s tickets do) instead. Rejected
  before this record was written — PIPE-21's whole premise was that doc-vs-doc comparison
  had already gone as far as it usefully could (see SPD-7's history) and a real ground-truth
  check was worth the corpus-management cost this ADR is about.

## Consequences

- `npm test` and CI will never catch a replay-validation regression automatically. If
  `replayDiff.ts`'s interpolation logic or `corpusReport.ts`'s privacy gate breaks, nothing
  fails red until someone runs the tooling by hand against the corpus — which only happens
  when a replay-validation ticket is actively being worked. This is a real, accepted gap,
  not an oversight: the alternative (committing private data) was judged worse.
- Every ticket that touches `tools/replay/` is responsible for its own manual verification
  pass and for writing what it found into its own `## Outcome` — PIPE-36 and PIPE-37 both
  did this (regression-baseline reproduction, corpus-wide manifest counts, a negative-control
  test of the privacy gate itself), and that pattern is the expected standard going forward,
  not a one-off.
- A future contributor without access to the private corpus can still read, review, and
  modify `tools/replay/*.ts`/`*.py` — the code is public and self-documenting — but cannot
  independently verify a change against real data without first getting corpus access
  through whatever process the private `uma-tools-plans` repo's own README/access model
  describes. That's a real onboarding friction this decision accepts.
- If this project ever needs replay validation to run in CI (for example, if false-negative
  or false-positive`tools/replay/` regressions become a recurring problem), the fix implied
  by this record is *not* "commit the corpus" — it would need a genuinely different
  mechanism (a private CI runner with corpus access, most likely) and would warrant its own
  ADR amending or superseding this one, not a quiet workaround.
