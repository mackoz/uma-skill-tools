# CLAUDE.md

Guidance for working in this repo. It's the race-simulation engine — no UI, no build step of its own beyond `tsc`/`ts-node` for its CLI tools. See `README.md` for the architecture (condition parsing, sample policies, `RaceSolver.ts`'s numerical integration).

## What this repo is

`mackoz/uma-skill-tools`, a fork of [`alpha123/uma-skill-tools`](https://github.com/alpha123/uma-skill-tools), used as a **git submodule** by [`mackoz/uma-tools`](https://github.com/mackoz/uma-tools) (the browser app built on top of this engine) — the same relationship `alpha123/uma-tools` has with its own upstream engine submodule. Most of what's imported beyond upstream came from [`Werseter/uma-skill-tools@kachi`](https://github.com/Werseter/uma-skill-tools/tree/kachi); see `mackoz/uma-tools`'s `plans/engine-comparison/forks.md` for the attribution and a doc-vs-engine-vs-upstream comparison this repo doesn't duplicate.

## The submodule workflow — read this before editing

**Changes here don't reach `mackoz/uma-tools` automatically.** The flow is: edit here → commit → push to `origin` (this repo) → in `mackoz/uma-tools`, `cd uma-skill-tools && git pull` (or checkout the new commit) → commit the resulting gitlink bump in `mackoz/uma-tools`. If you're working from a session that has both repos checked out as siblings, don't edit the copy inside `mackoz/uma-tools/uma-skill-tools/` expecting it to persist — that's a submodule checkout, not this repo's working tree; edits there are just as real but need the same commit-here-then-bump-there flow, and it's easy to lose track of which checkout you're actually in.

## Hard rules

1. **Never hand-edit `data/*.json`.** These are Perl-generated from the game's `master.mdb` (`tools/make_skill_data.pl` → `data/skill_data.json`, `tools/make_skillnames.pl` → `data/skillnames.json`, `tools/make_course_data.pl` → `data/course_data.json`). Edit the generating `.pl` script and regenerate. The one exception this repo's history has needed: a small number of specific, individually-verified value corrections sourced from a real `master.mdb` query or an already-computed-and-verified upstream value, applied via a short one-off script (not by hand) when a full regen wasn't possible — see the `Fix HP-1` commit for the pattern, and don't treat it as a precedent for casual hand-edits.
2. **Engine-only, no DOM/UI dependencies.** This code runs inside a web worker (`mackoz/uma-tools`'s `simulator.worker.ts`) and under plain `ts-node` for the CLI tools in `tools/` — don't import Preact, browser globals, or anything that assumes a DOM.
3. **`Random.ts`'s `Rule30CARng` is not what its name says.** It's an alias for a `prando`-backed PRNG, not a real Rule-30 cellular-automaton generator — don't assume upstream semantics or numeric output apply just because the class name matches something upstream also has.

## Known gaps (see `README.md`'s Caveats for the full list)

- No skill cooldowns — a skill can only activate once per simulated race.
- No value/duration/level scaling tables.
- `accumulatetime` combined with a distribution-modeled condition may still activate earlier than the distribution predicts (no per-skill exemption list, unlike upstream's).
- A handful of shipped skill conditions (`temptation_opponent_count_behind`/`_infront`, `is_other_character_activate_advantage_skill`, plus ~11 JP-only names) aren't registered in `ActivationConditions.ts`'s `Conditions` table. Referencing one now throws a named `ConditionParser` `ParseError: unknown condition: <name>` at skill-build time instead of a bare `TypeError` — see `README.md`'s "Unknown skill conditions now fail loudly, by name" section.

## `test/`, `tools/`, and pre-existing `tsc` errors

`npx tsc --noEmit` reports pre-existing errors in `test/` and `tools/` (a dangling `EnhancedHpPolicy` import in `RaceSolverBuilder.ts`, and a few CLI tools calling an older `RaceSolver` constructor/builder shape than what's actually exported) — these predate any change made here and aren't part of the bundled engine surface (`mackoz/uma-tools`'s builds only pull in the top-level `.ts` files, not `test/`/`tools/`). Don't treat a clean top-level build as proof these pass, and don't feel obligated to fix them incidentally while touching something else — they're a separate, pre-existing cleanup task.
