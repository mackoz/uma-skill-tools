# CLAUDE.md

Guidance for working in this repo. It's the race-simulation engine — no UI, no build step of its own beyond `tsc`/`ts-node` for its CLI tools. See `README.md` for the architecture (condition parsing, sample policies, `RaceSolver.ts`'s numerical integration).

## What this repo is

`mackoz/uma-skill-tools`, a fork of [`alpha123/uma-skill-tools`](https://github.com/alpha123/uma-skill-tools), used as a **git submodule** by [`mackoz/uma-tools`](https://github.com/mackoz/uma-tools) (the browser app built on top of this engine) — the same relationship `alpha123/uma-tools` has with its own engine submodule. Most of what's imported beyond the alpha123 baseline came from [`Werseter/uma-skill-tools@kachi`](https://github.com/Werseter/uma-skill-tools/tree/kachi).

## The submodule workflow — read this before editing

**Changes here don't reach `mackoz/uma-tools` automatically.** The flow is: edit here → commit → push to `origin` (this repo) → in `mackoz/uma-tools`, `cd uma-skill-tools && git pull` (or checkout the new commit) → commit the resulting gitlink bump in `mackoz/uma-tools`. If you're working from a session that has both repos checked out as siblings, don't edit the copy inside `mackoz/uma-tools/uma-skill-tools/` expecting it to persist — that's a submodule checkout, not this repo's working tree; edits there are just as real but need the same commit-here-then-bump-there flow, and it's easy to lose track of which checkout you're actually in.

## Branching & PRs

- **One open PR in this repo at a time.** Before creating a branch, check for an existing open PR/branch covering the same area (`gh pr list`) and push to that branch instead of branching off the default branch again.
- A PR merged here isn't done until `mackoz/uma-tools` bumps its submodule gitlink (see the workflow above).

## Hard rules

1. **Never hand-edit `data/*.json`.** These are Perl-generated from the game's `master.mdb` (`tools/make_skill_data.pl` → `data/skill_data.json`, `tools/make_skillnames.pl` → `data/skillnames.json`, `tools/make_course_data.pl` → `data/course_data.json`). Edit the generating `.pl` script and regenerate. The one exception this repo's history has needed: a small number of specific, individually-verified value corrections sourced from a real `master.mdb` query or an already-computed-and-verified value from alpha123's data, applied via a short one-off script (not by hand) when a full regen wasn't possible — see the `Fix HP-1` commit for the pattern, and don't treat it as a precedent for casual hand-edits.
2. **Engine-only, no DOM/UI dependencies.** This code runs inside a web worker (`mackoz/uma-tools`'s `simulator.worker.ts`) and under plain `ts-node` for the CLI tools in `tools/` — don't import Preact, browser globals, or anything that assumes a DOM.
3. **`Random.ts`'s `Rule30CARng` is not what its name says.** It's an alias for a `prando`-backed PRNG, not a real Rule-30 cellular-automaton generator — don't assume alpha123's semantics or numeric output apply just because the class name matches something alpha123's engine also has.
4. **Pacer skill triggers are sampled once per race slot, not once per scenario** (`prepPacerTriggers`, called before the scenario loop — `mackoz/uma-tools`'s `umalator/compare.ts` is the one caller; `buildPacer` only indexes the precomputed table). The operational trap: this was a genuine numeric-output change, so if you're diffing simulator output against a pre-`0861c8f` run and a virtual pacemaker is involved, expect a difference — that's the fix, not a regression. Full rationale and rejected alternatives: `docs/adr/0007-pacer-triggers-once-per-slot.md`.
5. **Significant design decisions get an ADR.** `docs/adr/` records the *why* behind modeling approximations, numeric-output-affecting designs, and failure-handling posture — including reconstructed rationale for inherited decisions. Before "fixing" something surprising (the RNG shim, the field-condition stand-ins, the loud unknown-condition errors), read the matching record; when a change settles a question that could have gone another way, add or amend one (see `docs/adr/README.md` for the format).

## Known gaps (see `README.md`'s Caveats for the full list)

- No skill cooldowns — a skill can only activate once per simulated race.
- No value/duration/level scaling tables.
- `accumulatetime` combined with a distribution-modeled condition may still activate earlier than the distribution predicts (no per-skill exemption list, unlike alpha123's engine).
- A handful of shipped skill conditions (`temptation_opponent_count_behind`/`_infront`, `is_other_character_activate_advantage_skill`, plus 15 JP-only names) aren't registered in `ActivationConditions.ts`'s `Conditions` table — 18 unregistered names total. Referencing one now throws a named `ConditionParser` `ParseError: unknown condition: <name>` at skill-build time instead of a bare `TypeError` — see `README.md`'s "Unknown skill conditions now fail loudly, by name" section.

## `test/`, `tools/`, and pre-existing `tsc` errors

As of 2026-08-20, `npx tsc --noEmit` reports **14 pre-existing errors**: two in `RaceSolverBuilder.ts`, five across `test/`, and seven across `tools/gain.ts`/`tools/dump.ts`. The causes include a dangling `EnhancedHpPolicy` import, missing `HorseDesc.mood` values in test fixtures, and CLI tools calling an older `RaceSolver` constructor shape. These predate this documentation update and aren't part of the bundled engine surface (`mackoz/uma-tools`'s builds only pull in the top-level `.ts` files, not `test/`/`tools/`). Don't treat a clean browser build as proof these pass, and don't feel obligated to fix them incidentally while touching something else — they're a separate cleanup task.

## Running tests

`npm test` runs `test/parser.ts` (a `tape`/`fast-check` property test round-tripping the condition parser's AST through stringify/parse), `test/activation-sampling.ts` (12 tests covering `ErlangRandomPolicy`/`LogNormalRandomPolicy` sampling bounds and `deriveSeed` stream isolation), and `test/rushed-escape-roll.ts` (pins the fixed Rushed escape-roll behavior — exactly 3 rolls at 3s/6s/9s at 55% each, forced end at 12s, timestep-independent — against a minimal stand-in that exercises `updateRushedState()`/`endRushedState()` directly), and all three currently pass. `test/parser.ts` used to be a stub even though `tape`/`fast-check` were already installed; `test/activation-sampling.ts` was added alongside the statistical-sampling stabilization fix; `test/rushed-escape-roll.ts` was added alongside the DYN-11 fix. `test/race.ts` (a similar property test over `RaceSolver`, parameterized via `--runs`/`--timestep`) is **not** wired into `npm test` and currently has three `RaceParams`/`HorseDesc` type errors. `test/bench/bench.ts` and `test/regression/` (a checkpoint-based regression system — `create-checkpoint.ts`/`check.ts`/`knowncases.ts`) are also standalone, invoked directly via `ts-node`, not part of `npm test`.

## Documentation changes

- When rewriting a doc (`README.md`, `docs/adr/`), keep its existing format — tables stay tables; don't convert a table to prose unless explicitly asked.
- Verify factual claims (mechanics numbers, table/column names, error behavior) against the source or a real `master.mdb` query before writing them, and cite the file you checked.

## Exploring `master.mdb`

Every generator script in `tools/` (`make_skill_data.pl`, `make_skillnames.pl`, `make_course_data.pl`) reads specific tables out of the game's `master.mdb` — see `mackoz/uma-tools`'s `docs/data-pipeline.md` for the full table list. `sqlite3` (Apple's bundled CLI, already on any Mac — `sqlite3 master.mdb` then `.tables`/`.schema <table>`/plain SQL) is the fastest way to check whether a table has the row or column a script expects before writing a one-off Perl or Node script to do the same query. No decryption needed for `master.mdb` itself — the chacha20/XOR encryption `docs/data-pipeline.md`'s "This fork's asset extraction is broken" section describes is specific to the separate `meta` asset-manifest DB (icon/asset extraction), not the skill/course/uma data these `.pl` scripts read.
